import { repositorySyncService } from "../../features/repository/repositorySync.service.js";
import { syncQueue } from "../../config/queues.js";
import {
  CodeChunkSearchResult,
  RetrievalCandidate,
  RetrievalOptions,
  RetrievedContext,
  RetrievalTrace,
  RETRIEVAL_WEIGHTS,
  InterviewStartContext,
  InterviewFollowUpContext,
  InterviewGranularity,
  ModuleInventoryEntry,
  DocChunkSearchResult,
  QAGraphNeighbors,
} from "./retrievalTypes.js";
import { ConversationTurn, buildQAEmbeddingQuery } from "../../shared/utils/conversationalQuery.js";
import { InterviewState, MAX_TURNS_ON_MODULE } from "../../features/interview/interviewTypes.js";

import { semanticRetrievalService } from "./semanticRetrieval.service.js";
import { repositoryGraphService } from "../../features/repository/repositoryGraph.service.js";
import { relatedTestDiscoveryService } from "./relatedTestDiscovery.service.js";
import { candidateMergerService } from "./candidateMerger.service.js";
import { retrievalRerankerService, primarySource } from "./retrievalReranker.service.js";
import { contextBudgetService } from "./contextBudget.service.js";
import { pool } from "../../config/db.js";
import { performance } from "perf_hooks";
import { repositoryMapService } from "./repositoryMap.service.js";
import { granularityOf } from "../../features/interview/interviewFocusResolution.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docRetrievalLog, docPreview } from "../../shared/utils/readmeDebugLog.js";

const DEFAULT_OPTIONS: RetrievalOptions = {
  maxComponents: 3,
  maxFiles: 5,
  maxCodeChunks: 10,
  similarityThreshold: 0.6,
  maxTokens: 15000,
  // Documentation starts at the same threshold as code for consistency, but
  // is a separate knob so it can be retuned independently — code chunks and
  // prose don't necessarily share a similarity distribution.
  // 5, not 3: documentation rows now also include manifest/config files
  // (package.json, docker-compose, .env.example), which must not crowd out
  // the README setup sections they are usually retrieved alongside.
  maxDocChunks: 5,
  docSimilarityThreshold: 0.6,
};

/**
 * QA's minimal graph augmentation ("what depends on X"). A higher bar than
 * the base 0.6 threshold, deliberately: this only fires once code is already
 * a CONFIDENT match on its own terms, not via any cross-type comparison
 * against docs/summaries — see retrieveQAContext's graph-augmentation block.
 */
const QA_GRAPH_AUGMENTATION_SIMILARITY_FLOOR = 0.75;
const QA_GRAPH_NEIGHBOR_LIMIT = 12;

/**
 * Bounds for review's structural expansion.
 *
 * These are the safety rails that make graph expansion usable now that it
 * returns real code instead of discarded prose. Without them, changing a
 * widely-imported utility would pull in every caller in the repository.
 *
 * Note the per-class *file* lists are NOT truncated arbitrarily — the
 * `totalLimit` passed to searchCodeChunksInFiles ranks across all of a class's
 * files by similarity and takes the best, which is strictly better than
 * slicing an unordered path list. The fan-in rule below is what prevents a
 * pathological path list reaching SQL in the first place.
 */
const REVIEW_LIMITS = {
  /** Changed files whose graph we expand. Every changed file still appears in the diff. */
  maxChangedFilesForExpansion: 20,
  /** Above this many non-test callers, a file is a shared util: its callers say nothing. */
  maxDependentFanIn: 30,
  /** Chunks per individual file, so one chunk-dense file can't fill a class. */
  perFileChunkLimit: 3,
  changedTotalLimit: 40,
  dependentTotalLimit: 20,
  dependencyTotalLimit: 20,
  testTotalLimit: 12,
  /** Was effectively 5 via review.service's maxCodeChunks; the budget now does the capping. */
  semanticLimit: 25,
};

/**
 * Bounds for Interview's structural retrieval. See InterviewStartContext /
 * InterviewFollowUpContext for what each block is for. v2: retrieval is
 * granularity-keyed (REPOSITORY/MODULE/FILE), not action-keyed — see
 * buildModuleInventory, retrieveInterviewStartContext and
 * retrieveInterviewFollowUpContext.
 */
const INTERVIEW_LIMITS = {
  // NARROW at REPOSITORY: module names offered as one-level-finer options.
  narrowModuleLimit: 6,
  // NARROW at MODULE: file names within the current module.
  narrowFileLimit: 8,
  // FRONTIER: unvisited modules offered for NEW_TOPIC. Names only — no code
  // until a later turn's resolved focus actually narrows into one of them.
  // Small while drilling — still offered as an escape hatch if the model
  // judges the topic exhausted early — large once the module bound is hit
  // or NEW_TOPIC was the just-chosen action.
  frontierModuleLimitSmall: 2,
  frontierModuleLimitLarge: 6,

  // GROUNDING: keyed on the QUESTION vector. Code only at FILE granularity —
  // a MODULE/REPOSITORY-scope question wasn't about specific code.
  groundingCodeLimit: 4,
  groundingDocLimit: 2,

  // STAY at FILE (LOCAL): structural neighbours (deps/dependents) of the
  // focus file via the graph, not semantic search.
  localPerFileChunks: 3,
  localTotalLimit: 5,

  // STAY at REPOSITORY/MODULE: doc chunks toward deeper framing, using a
  // dedicated query (tradeoffs/design-decisions at REPOSITORY, the module
  // name itself at MODULE) rather than the raw question vector.
  stayDocLimit: 3,
};

export class RepositoryRetrievalService {
  /**
   * Blocks retrieval until the repository has a searchable index — or throws.
   * Gated on `last_indexed_sha`, which is set once the first full index
   * (sync/parse/embed/import-graph) completes and never cleared, so a repo
   * stays usable while a later delta sync is still indexing.
   *
   * Previously this waited on full `indexing_status === 'INDEXED'`
   * (LLM summarization included) with a single 45s budget that, when it ran
   * out, just logged and returned anyway regardless of real state — reviews
   * /QA/interview answers were routinely generated against a partially- or
   * un-indexed repo, silently. The fix here is NOT "wait longer" on its own
   * — this still runs inline on a synchronous HTTP request (POST /reviews,
   * chat stream, interview start), so blocking for minutes would just trade
   * a silently-wrong result for a hung request/proxy timeout. Instead: keep
   * the wait bounded and request-friendly, and when the
   * deadline is hit without the repo being searchable, throw a specific,
   * catchable error instead of pretending everything's fine. Callers already
   * surface `error.message` back to the client (see review.controller.ts,
   * chat.controller.ts), so this becomes a clear "still indexing, try again
   * shortly" instead of a bad result.
   */
  private async ensureSearchable(clerkUserId: string, repositoryId: string) {
    console.log(`[RetrievalService] Triggering JIT Sync check for repository ${repositoryId}...`);

    const maxWaitMs = 60000;
    const pollIntervalMs = 2000;
    const startTime = Date.now();
    const deadline = () => Date.now() - startTime < maxWaitMs;

    // 0. No valid index and the last run failed: recovery is an explicit retry
    // (start-working), not a side effect of a session request — otherwise a
    // deterministic failure would start a full rebuild on every session.
    const { rows: current } = await pool.query(
      "SELECT last_indexed_sha, indexing_status FROM repositories WHERE id = $1",
      [repositoryId],
    );
    if (!current[0]?.last_indexed_sha && current[0]?.indexing_status === "FAILED") {
      throw new Error("INDEXING_FAILED");
    }

    // 1. Enqueue the sync job, then wait for THIS job to finish (not just any past
    // state) before looking at last_indexed_sha — the repo can already read
    // searchable from a previous sync while this job is still sitting in the queue.
    const { jobId } = await repositorySyncService.enqueueSync(clerkUserId, repositoryId);
    const job = jobId ? await syncQueue.getJob(jobId) : undefined;

    if (job) {
      while (deadline()) {
        const state = await job.getState();
        if (state === "completed" || state === "failed" || state === "unknown") break;
        await new Promise((res) => setTimeout(res, pollIntervalMs));
      }
    }

    // 2. The sync job only enqueues indexing chunks; it doesn't wait for them.
    // Poll the repo's last_indexed_sha/indexing_status until indexing finishes.
    while (deadline()) {
      const { rows } = await pool.query(
        "SELECT last_indexed_sha, indexing_status FROM repositories WHERE id = $1",
        [repositoryId]
      );

      const status = rows[0]?.indexing_status;

      if (rows[0]?.last_indexed_sha) {
        console.log(`[RetrievalService] Repository ${repositoryId} is searchable (status: ${status}).`);
        return;
      }

      if (status === 'FAILED') {
        console.error(`[RetrievalService] Repository ${repositoryId} indexing FAILED — refusing to retrieve on a broken index.`);
        throw new Error('INDEXING_FAILED');
      }

      // status is NOT_STARTED / INDEXING — still in progress, keep waiting.
      await new Promise(res => setTimeout(res, pollIntervalMs));
    }

    console.error(
      `[RetrievalService] Timed out after ${maxWaitMs / 1000}s waiting for repository ${repositoryId} to become searchable — refusing to retrieve on a partial index.`,
    );
    throw new Error('INDEXING_IN_PROGRESS');
  }

  /**
   *R ead-only readiness check — no sync enqueue, no polling, no GitHub round
   * trip. Throws the same catchable error strings as ensureSearchable when
   * the repo isn't currently searchable, but returns instantly otherwise.
   *
   * Used on every Interview answer turn instead of ensureSearchable: the
   * session was already made searchable at start, so this is a defensive
   * check for the rare case a repo's index becomes invalid mid-session — not
   * a "wait for it to become ready" gate. Calling the full ensureSearchable
   * per turn would put a GitHub sync round trip on every single answer.
   */
  private async assertSearchable(repositoryId: string): Promise<void> {
    const { rows } = await pool.query(
      "SELECT last_indexed_sha, indexing_status FROM repositories WHERE id = $1",
      [repositoryId],
    );
    const status = rows[0]?.indexing_status ?? "NOT_STARTED";

    if (rows[0]?.last_indexed_sha) return;

    if (status === "FAILED") {
      console.error(`[RetrievalService] Repository ${repositoryId} indexing FAILED — refusing to retrieve on a broken index.`);
      throw new Error("INDEXING_FAILED");
    }

    console.warn(`[RetrievalService] Repository ${repositoryId} is not searchable (status: ${status}) — refusing this turn.`);
    throw new Error("INDEXING_IN_PROGRESS");
  }

  // --- QA Mode ---
  public async retrieveQAContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    opts?: RetrievalOptions,
    // Absent (or isNewSession true) swaps to the full sync-enqueue-and-poll
    // ensureSearchable; false uses the cheap read-only assertSearchable, the
    // same distinction Interview's follow-up turns already rely on
    // (assertSearchable's own doc comment). recentHistory is used ONLY to
    // resolve dangling references ("that", "where is this implemented") in
    // the embedding query below — it is never rendered into the returned
    // context or the prompt built from it.
    conversation?: { isNewSession: boolean; recentHistory: ConversationTurn[] },
  ): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const isNewSession = conversation?.isNewSession ?? true;
    if (isNewSession) {
      await this.ensureSearchable(clerkUserId, repositoryId);
    } else {
      await this.assertSearchable(repositoryId);
    }

    // recentHistory's last element is the just-saved CURRENT user turn (see
    // chat.service.ts#streamMessage) — excluded here so buildQAEmbeddingQuery
    // resolves against the turn BEFORE this one, not against itself.
    const priorHistory = (conversation?.recentHistory ?? []).slice(0, -1);
    const embeddingQuery = buildQAEmbeddingQuery(query, priorHistory);
    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(embeddingQuery.text);

    const context: RetrievedContext = {
      repositoryProfile: null,
      codeChunks: [],
      docChunks: [],
      metadata: {
        mode: "qa",
        usedFallback: false,
        query,
        embeddingQuery: embeddingQuery.text,
        usedConversationalBlend: embeddingQuery.usedHistory,
      },
    };

    // Documentation, code and the repository profile are read concurrently —
    // two pgvector reads against the SAME query vector plus one SHA-cached
    // profile. No LLM call and no classifier.
    //
    // Code is searched REPO-WIDE. It used to be scoped to the ≤5 files whose
    // LLM file summaries matched, with a repo-wide retry only when that scope
    // returned nothing — a recall ceiling observed live (10 chunks unscoped,
    // then 0 once summaries narrowed the scope to two unrelated files).
    //
    // Routing between docs and code is emergent rather than decided up front:
    // both are gated by their own threshold and whichever genuinely matches
    // the question wins. "How do I run this" surfaces README setup sections
    // and manifest/config rows; "how is auth implemented" surfaces code.
    const [docChunks, codeChunks, repositoryProfile] = await Promise.all([
      semanticRetrievalService.searchDocumentationChunks(
        repositoryId,
        queryVectorStr,
        options.maxDocChunks ?? DEFAULT_OPTIONS.maxDocChunks,
        options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold,
      ),
      semanticRetrievalService.searchCodeChunks(repositoryId, queryVectorStr, options),
      repositoryMapService.getRepositoryProfile(repositoryId),
    ]);

    context.docChunks = docChunks;
    context.codeChunks = codeChunks;
    context.repositoryProfile = repositoryProfile.text || null;

    // Per-type top similarity, for the provider's relevance-and-role
    // weighting (which section gets full/reduced/omitted budget). Doc/code
    // are already similarity-ordered by their own queries, so [0] is exact,
    // not approximate. Never used to compare raw scores directly across
    // types on its own — see the Design principle note in the Q&A plan.
    context.metadata.evidenceSimilarities = {
      doc: docChunks[0]?.similarity ?? null,
      code: codeChunks[0]?.similarity ?? null,
    };

    console.log(
      `[Retrieval] QA for ${repositoryId}: ${codeChunks.length} code chunk(s), ${docChunks.length} doc section(s), profile=${repositoryProfile.text.length} chars.`,
    );

    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    docRetrievalLog(
      `Q&A query="${docPreview(query, 80)}" -> ${docChunks.length} doc section(s), ` +
        `${codeChunks.length} code chunk(s), profile=${repositoryProfile.text.length} chars, ` +
        `docThreshold=${options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold}.`,
    );
    if (embeddingQuery.usedHistory) {
      docRetrievalLog(
        `  Conversational blend fired — embedded "${docPreview(embeddingQuery.text, 120)}" instead of the raw question.`,
      );
    }
    docChunks.forEach((d, i) => {
      docRetrievalLog(
        `  [Doc ${i + 1}] ${d.filePath} § "${d.sectionPath}" ` +
          `sim=${Number(d.similarity).toFixed(4)} lines ${d.lineStart}-${d.lineEnd} :: ${docPreview(d.content)}`,
      );
    });
    if (docChunks.length > 0 && codeChunks.length > 0) {
      // Both matched — useful for sanity-checking that similarity-based
      // routing is behaving (docs should dominate on "how do I run this",
      // code on "how is X implemented").
      docRetrievalLog(
        `  Top doc sim=${Number(docChunks[0].similarity).toFixed(4)} vs ` +
          `top code sim=${Number(codeChunks[0].similarity).toFixed(4)}.`,
      );
    }

    // Minimal graph augmentation ("what depends on X" / "what does X
    // import"): single anchor file (the top code match, not every changed
    // file like Review), single hop, names only — no code fetched for
    // neighbors, no candidate/rerank/budget machinery. Gated on a HIGHER bar
    // than the base 0.6 threshold so this only fires when code is already a
    // confident match, deliberately not a cross-type comparison against
    // docs/summaries — see the Design principle note on evidence roles.
    context.graphNeighbors = null;
    if (codeChunks.length > 0 && codeChunks[0].similarity >= QA_GRAPH_AUGMENTATION_SIMILARITY_FLOOR) {
      const anchorFile = codeChunks[0].filePath;
      const [deps, dependents] = await Promise.all([
        repositoryGraphService.getDirectDependencies(repositoryId, anchorFile),
        repositoryGraphService.getDirectDependents(repositoryId, anchorFile),
      ]);
      // Excludes the anchor itself in case of a self-referential edge, and
      // never overlaps with the file already shown in full in ## Code.
      const dependencies = deps.filter((f) => f !== anchorFile).slice(0, QA_GRAPH_NEIGHBOR_LIMIT);
      const dependentsList = dependents.filter((f) => f !== anchorFile).slice(0, QA_GRAPH_NEIGHBOR_LIMIT);
      if (dependencies.length > 0 || dependentsList.length > 0) {
        context.graphNeighbors = { anchorFile, dependencies, dependents: dependentsList };
        docRetrievalLog(
          `  Graph augmentation fired on ${anchorFile} (sim=${Number(codeChunks[0].similarity).toFixed(4)}): ` +
            `${dependencies.length} dependenc(y/ies), ${dependentsList.length} dependent(s).`,
        );
      }
    }

    return context;
  }

  // --- Interview Mode: Coverage-driven retrieval ---
  /** Unvisited-first ordering used by both FRONTIER (modules) and NARROW-at-MODULE (files) — coverage should bias toward what hasn't been seen without ever excluding what has. */
  private unvisitedFirst<T>(items: T[], visited: Set<string>, keyOf: (item: T) => string): T[] {
    const unvisited = items.filter((i) => !visited.has(keyOf(i)));
    const seen = items.filter((i) => visited.has(keyOf(i)));
    return [...unvisited, ...seen];
  }

  /**
   * Q&A retrieves for RELEVANCE (answer this question). Review retrieves for
   * BLAST RADIUS (judge this change). Interview retrieves for COVERAGE,
   * gated by DRILL DEPTH: it must move around the repository instead of
   * orbiting whatever the candidate last happened to mention, and it must
   * open with a genuine orientation question rather than an arbitrary
   * implementation detail.
   *
   * DELIBERATELY fetches zero code chunks. The previous implementation
   * seeded the opening question with code chunks from graph-fan-in "seed
   * files" — plausible-sounding but, once retrieved, structurally
   * indistinguishable from arbitrary (a Mongoose schema field and an
   * entry-point route handler both just look like "a chunk"). The model was
   * then told to "prefer" the architecturally central ones, and it didn't,
   * because the instruction couldn't actually tell them apart either. The
   * fix is structural, not instructional: retrieval simply doesn't offer
   * code at REPOSITORY scope, so turn 1 is grounded in `moduleInventory`
   * (real, from the index) plus the deterministic repository profile and
   * whatever docChunks match — never an arbitrary code snippet.
   */
  public async retrieveInterviewStartContext(
    clerkUserId: string,
    repositoryId: string,
    opts?: RetrievalOptions,
    // skipSync swaps the sync-enqueue-and-poll gate for the read-only
    // assertSearchable check. Used by scripts/evalRetrieval.ts, which must
    // measure retrieval without enqueuing real sync jobs.
    extra?: { skipSync?: boolean },
  ): Promise<InterviewStartContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    if (extra?.skipSync) {
      await this.assertSearchable(repositoryId);
    } else {
      await this.ensureSearchable(clerkUserId, repositoryId);
    }

    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(
      "What does this project do? Explain its architecture, main components, and how it's structured.",
    );

    // The repository profile is deterministic and keyed by the indexed SHA, so
    // it always describes the same revision as the code — no READY gate.
    const [moduleInventory, docChunks, profile] = await Promise.all([
      repositoryMapService.buildModuleInventory(repositoryId),
      semanticRetrievalService.searchDocumentationChunks(
        repositoryId, queryVectorStr,
        options.maxDocChunks ?? DEFAULT_OPTIONS.maxDocChunks,
        options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold,
      ),
      repositoryMapService.getRepositoryProfile(repositoryId),
    ]);
    const repositoryProfile = profile.text || null;

    const contextPaths = moduleInventory.flatMap((m) => m.files);
    const contextModules = moduleInventory.map((m) => m.module);

    console.log(
      `[INTERVIEW-RETRIEVAL] start repo=${repositoryId}: 0 code chunks (v2 — code is fetched only ` +
        `once focus narrows to FILE granularity), ${moduleInventory.length} module(s) ` +
        `[${contextModules.join(", ")}], ${docChunks.length} doc section(s), ` +
        `profile=${profile.text.length} chars.`,
    );

    return { repositoryProfile, moduleInventory, docChunks, contextPaths, contextModules };
  }

  /**
   * Follow-up retrieval is granularity-keyed (plan v2 §5/§6), not
   * action-keyed: `granularity` is the CURRENT focus's granularity — i.e.
   * what the just-asked question (the one the candidate is now answering)
   * was actually scoped to — and drives GROUNDING, STAY and NARROW alike.
   * The hard rule: code chunks are fetched ONLY at FILE granularity. STAY
   * and NARROW are always assembled TOGETHER (never one instead of the
   * other) so the model's own `nextFocus` decides whether the next question
   * stays or narrows — retrieval only offers the menu, exactly like the
   * existing LOCAL/FRONTIER split this mirrors.
   */
  public async retrieveInterviewFollowUpContext(
    repositoryId: string,
    question: string,
    state: InterviewState,
  ): Promise<InterviewFollowUpContext> {
    await this.assertSearchable(repositoryId);

    const granularity: InterviewGranularity = granularityOf(state.currentFocus ?? { filePath: null, symbolName: null, module: null });
    const focusFile = state.currentFocus?.filePath ?? null;
    const focusModule = state.currentFocus?.module ?? null;
    const visitedFiles = new Set(state.visitedFiles ?? []);
    const visitedModules = new Set(state.visitedModules ?? []);

    // lastAction/turnsOnCurrentModule are the PREVIOUS turn's known state —
    // it lets FRONTIER sizing route with zero extra LLM calls. The action
    // for THIS question was already decided last turn; the action for the
    // NEXT one isn't known until this turn's call returns, which is why
    // STAY/NARROW/FRONTIER are always all assembled regardless.
    const moduleBoundReached = (state.turnsOnCurrentModule ?? 0) >= MAX_TURNS_ON_MODULE;
    const wantsFrontierLarge = moduleBoundReached || state.lastAction === "NEW_TOPIC";

    const questionVectorStr = await semanticRetrievalService.getQueryVectorStr(question);

    // A second, distinct embedding for STAY's deeper doc framing — only one
    // of these ever actually fires per turn, gated by granularity below.
    const stayDocQuery =
      granularity === "MODULE"
        ? `${focusModule}: purpose, responsibilities, and how it fits into the rest of the system`
        : granularity === "REPOSITORY"
          ? "Why were these architectural and technical choices made in this project? Tradeoffs and design decisions."
          : null;
    const stayDocVectorPromise = stayDocQuery
      ? semanticRetrievalService.getQueryVectorStr(stayDocQuery)
      : Promise.resolve(null);

    const moduleInventoryPromise = repositoryMapService.buildModuleInventory(repositoryId);

    const [moduleInventory, stayDocVectorStr] = await Promise.all([
      moduleInventoryPromise,
      stayDocVectorPromise,
    ]);

    // GROUNDING — keyed on the QUESTION, never the answer. Restricted to
    // the CURRENT granularity's real material: code only at FILE, since a
    // MODULE/REPOSITORY-scope question wasn't about specific code and there
    // is nothing to check the answer against. The deterministic profile for
    // the current scope (module / repository) is SHA-keyed, so unlike the
    // summaries it replaced it needs no READY gate.
    let groundingCode: CodeChunkSearchResult[] = [];
    let groundingDocsPromise: Promise<DocChunkSearchResult[]>;
    let groundingProfilePromise: Promise<string | null> = Promise.resolve(null);

    // STAY — deeper material at the unchanged granularity.
    let stayCode: CodeChunkSearchResult[] = [];
    let stayDocsPromise: Promise<DocChunkSearchResult[]> = Promise.resolve([]);

    // NARROW — one level finer, offered ALONGSIDE stay.
    let narrowModules: ModuleInventoryEntry[] = [];
    let narrowFiles: string[] = [];

    if (granularity === "FILE" && focusFile) {
      const [deps, dependents] = await Promise.all([
        repositoryGraphService.getDirectDependencies(repositoryId, focusFile),
        repositoryGraphService.getDirectDependents(repositoryId, focusFile),
      ]);
      const neighbourFiles = Array.from(new Set([focusFile, ...deps, ...dependents]));

      const [groundingCodeRes, stayCodeRaw] = await Promise.all([
        semanticRetrievalService.searchCodeChunksInFiles(
          repositoryId, questionVectorStr, neighbourFiles,
          INTERVIEW_LIMITS.localPerFileChunks, INTERVIEW_LIMITS.groundingCodeLimit,
          DEFAULT_OPTIONS.similarityThreshold,
        ),
        semanticRetrievalService.searchCodeChunksInFiles(
          repositoryId, questionVectorStr, neighbourFiles,
          INTERVIEW_LIMITS.localPerFileChunks, INTERVIEW_LIMITS.localTotalLimit, 0,
        ),
      ]);
      groundingCode = groundingCodeRes;

      // Within-turn dedup: grounding and STAY both centre on the focus file,
      // so the same chunk can legitimately come back from both. Grounding
      // wins (it's what's actually used to judge the answer) and STAY drops
      // its copy, so the model isn't shown one span twice under two labels.
      const groundingKeys = new Set(groundingCode.map((c) => `${c.filePath}#${c.lineStart}-${c.lineEnd}`));
      stayCode = stayCodeRaw.filter((c) => !groundingKeys.has(`${c.filePath}#${c.lineStart}-${c.lineEnd}`));

      groundingDocsPromise = semanticRetrievalService.searchDocumentationChunks(
        repositoryId, questionVectorStr, INTERVIEW_LIMITS.groundingDocLimit, DEFAULT_OPTIONS.docSimilarityThreshold,
      );
      // No NARROW at FILE — nothing finer than an implementation to offer.
    } else if (granularity === "MODULE" && focusModule) {
      groundingDocsPromise = semanticRetrievalService.searchDocumentationChunks(
        repositoryId, questionVectorStr, INTERVIEW_LIMITS.groundingDocLimit, DEFAULT_OPTIONS.docSimilarityThreshold,
      );
      groundingProfilePromise = repositoryMapService
        .getModuleProfile(repositoryId, focusModule)
        .then((p) => p.text || null);

      stayDocsPromise = stayDocVectorStr
        ? semanticRetrievalService.searchDocumentationChunks(
            repositoryId, stayDocVectorStr, INTERVIEW_LIMITS.stayDocLimit, DEFAULT_OPTIONS.docSimilarityThreshold,
          )
        : Promise.resolve([]);

      const moduleEntry = moduleInventory.find((m) => m.module === focusModule);
      if (moduleEntry) {
        narrowFiles = this.unvisitedFirst(moduleEntry.files, visitedFiles, (f) => f).slice(
          0, INTERVIEW_LIMITS.narrowFileLimit,
        );
      }
    } else {
      // REPOSITORY
      groundingDocsPromise = semanticRetrievalService.searchDocumentationChunks(
        repositoryId, questionVectorStr, INTERVIEW_LIMITS.groundingDocLimit, DEFAULT_OPTIONS.docSimilarityThreshold,
      );
      groundingProfilePromise = repositoryMapService
        .getRepositoryProfile(repositoryId)
        .then((p) => p.text || null);

      stayDocsPromise = stayDocVectorStr
        ? semanticRetrievalService.searchDocumentationChunks(
            repositoryId, stayDocVectorStr, INTERVIEW_LIMITS.stayDocLimit, DEFAULT_OPTIONS.docSimilarityThreshold,
          )
        : Promise.resolve([]);

      narrowModules = this.unvisitedFirst(moduleInventory, visitedModules, (m) => m.module).slice(
        0, INTERVIEW_LIMITS.narrowModuleLimit,
      );
    }

    // FRONTIER — coverage. Unvisited-module names, ranked by fan-in (never
    // filtered to "relevant" — the point is a genuinely different area, not
    // one that merely resembles the current question). Feeds NEW_TOPIC.
    // Falls back to the full inventory once every module has been visited —
    // the interview should never structurally dead-end.
    const unvisitedModules = moduleInventory.filter((m) => !visitedModules.has(m.module));
    const frontierPool = unvisitedModules.length > 0 ? unvisitedModules : moduleInventory;
    const frontierModules = frontierPool.slice(
      0, wantsFrontierLarge ? INTERVIEW_LIMITS.frontierModuleLimitLarge : INTERVIEW_LIMITS.frontierModuleLimitSmall,
    );

    const [groundingDocs, groundingProfile, stayDocs] = await Promise.all([
      groundingDocsPromise, groundingProfilePromise, stayDocsPromise,
    ]);

    const contextPaths = Array.from(new Set([
      ...groundingCode.map((c) => c.filePath),
      ...stayCode.map((c) => c.filePath),
      ...narrowFiles,
    ]));
    const contextModules = Array.from(new Set([
      ...(focusModule ? [focusModule] : []),
      ...narrowModules.map((m) => m.module),
      ...frontierModules.map((m) => m.module),
    ]));

    const usedFallback = granularity === "FILE" && groundingCode.length === 0 && stayCode.length === 0;

    console.log(
      `[INTERVIEW-RETRIEVAL] follow-up repo=${repositoryId}: granularity=${granularity} ` +
        `focus=${focusFile ?? focusModule ?? "(repository)"} turnsOnFocus=${state.turnsOnCurrentFocus ?? 0} ` +
        `turnsOnModule=${state.turnsOnCurrentModule ?? 0} moduleBoundReached=${moduleBoundReached} ` +
        `lastAction=${state.lastAction} -> grounding ${groundingCode.length}code/${groundingDocs.length}doc/` +
        `${groundingProfile ? "1" : "0"}profile, stay ${stayCode.length}code/${stayDocs.length}doc, ` +
        `narrow ${narrowModules.length}module/${narrowFiles.length}file, ` +
        `frontier ${frontierModules.length}module (${wantsFrontierLarge ? "large" : "small"}), ` +
        `query="${docPreview(question, 80)}".`,
    );

    return {
      granularity,
      groundingCode, groundingDocs, groundingProfile,
      stayCode, stayDocs,
      narrowModules, narrowFiles,
      frontierModules,
      contextPaths, contextModules, usedFallback,
    };
  }

  // --- REVIEW MODE: Change-centric Retrieval Pipeline ---
  /**
   * Retrieves the "blast radius" of a pull request: the changed code itself,
   * its callers, its callees, its tests, and relevant documentation.
   *
   * The governing rule: the GRAPH decides WHICH files matter, then pgvector fetches their CODE.
   */
  public async retrieveReviewContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    changedFiles: string[],
    opts?: RetrievalOptions,
    docQuery?: string | null,
    // skipSync: read-only readiness check instead of enqueuing a sync (see
    // retrieveInterviewStartContext).
    // fullyHeadCoveredFiles: changed files whose post-change enclosing code
    // was attached from the PR head with coverage EXACTLY "guaranteed" (see
    // features/review/changedCodeContext.ts). Only these skip the
    // default-branch changed_file chunk fetch; they still take part in
    // single-class assignment and graph expansion. Never pass partially
    // covered files here — their unmapped hunks would lose all context.
    extra?: { skipSync?: boolean; fullyHeadCoveredFiles?: string[] },
  ): Promise<RetrievedContext> {
    const startTime = performance.now();
    const options = { ...DEFAULT_OPTIONS, ...opts };
    if (extra?.skipSync) {
      await this.assertSearchable(repositoryId);
    } else {
      await this.ensureSearchable(clerkUserId, repositoryId);
    }

    const rawCandidates: RetrievalCandidate[] = [];

    const trace: RetrievalTrace = {
      timingMs: {
        graphExpansion: 0,
        semanticRetrieval: 0,
        mergeAndRerank: 0,
        budgetAllocation: 0,
        total: 0
      },
      counts: {
        changedFile: 0,
        graphDependency: 0,
        graphDependent: 0,
        relatedTest: 0,
        semantic: 0,
        totalPreMerge: 0,
        totalPostMerge: 0,
        finalAccepted: 0
      },
      budget: {
        changedCodeTokens: 0,
        graphTokens: 0,
        testTokens: 0,
        semanticTokens: 0,
        totalTokens: 0
      },
      droppedCandidates: []
    };

    const emptyContext = (): RetrievedContext => ({
      repositoryProfile: null,
      codeChunks: [], docChunks: [],
      metadata: { mode: "review", usedFallback: false, query, trace },
    });

    // Nothing reviewable (e.g. every file matched the prompt builder's
    // IGNORED_PATTERNS). An unfiltered semantic search for a lockfile-only PR
    // returns noise; returning nothing is correct.
    if (!changedFiles || changedFiles.length === 0) {
      trace.timingMs.total = performance.now() - startTime;
      docRetrievalLog(`Review: no reviewable changed files — skipping retrieval entirely.`);
      return emptyContext();
    }

    // `docQuery === undefined` means the caller didn't opt in — reuse the code
    // query. `docQuery === null` is an explicit "there isn't enough prose to
    // search on", and documentation is skipped rather than matched against
    // whatever sits nearest the origin.
    const effectiveDocQuery = docQuery === undefined ? query : docQuery;
    const skipDocumentation = effectiveDocQuery === null;

    // Both embeddings issue together, so the second costs no wall-clock.
    const [queryVectorStr, docVectorStr] = await Promise.all([
      semanticRetrievalService.getQueryVectorStr(query),
      skipDocumentation || effectiveDocQuery === query
        ? Promise.resolve(null)
        : semanticRetrievalService.getQueryVectorStr(effectiveDocQuery!),
    ]);

    if (skipDocumentation) {
      docRetrievalLog(
        `Review: skipping documentation retrieval — the PR has no meaningful ` +
          `title/description to match prose against. Returning no docs beats ` +
          `returning an arbitrary section.`,
      );
    } else if (docVectorStr) {
      docRetrievalLog(`Review: documentation searched with its own query: "${docPreview(effectiveDocQuery!, 120)}"`);
    }

    // ---- STAGE A: resolve the structural file set (paths only, no content)
    let t0 = performance.now();

    const changedSet = new Set(changedFiles);
    const testSet = new Set<string>();
    const dependentSet = new Set<string>();
    const dependencySet = new Set<string>();
    const fanInSuppressed: string[] = [];

    // A huge PR shouldn't fan out to hundreds of graph queries. This caps
    // EXPANSION only — every changed file still appears in the diff.
    const expansionFiles = changedFiles.slice(0, REVIEW_LIMITS.maxChangedFilesForExpansion);

    // Batched across all expansion files (2 queries total) instead of one
    // deps+dependents round trip per file.
    const [depsByFile, dependentsByFile] = await Promise.all([
      repositoryGraphService.getDirectDependenciesForFiles(repositoryId, expansionFiles),
      repositoryGraphService.getDirectDependentsForFiles(repositoryId, expansionFiles),
    ]);

    for (const file of expansionFiles) {
      const deps = depsByFile.get(file) ?? [];
      const dependents = dependentsByFile.get(file) ?? [];

      // Tests are derived from the dependents we already have, rather than
      // calling discoverTestsForFile (which would re-run the same query).
      const tests = dependents.filter((d) => relatedTestDiscoveryService.isTestFile(d));
      const nonTestDependents = dependents.filter((d) => !relatedTestDiscoveryService.isTestFile(d));

      for (const t of tests) testSet.add(t);

      // Fan-in suppression: a file with 200 callers is a shared utility, and
      // each individual caller carries almost no information about the change.
      // Without this, changing utils/logger.ts would flood the prompt.
      // Tests are kept regardless — a widely-used util's tests are still the
      // best statement of its intended behaviour.
      if (nonTestDependents.length > REVIEW_LIMITS.maxDependentFanIn) {
        fanInSuppressed.push(file);
      } else {
        for (const d of nonTestDependents) dependentSet.add(d);
      }

      for (const d of deps) dependencySet.add(d);
    }

    // Single-class assignment, strongest wins: changed > test > dependent >
    // dependency. Without this a file that is both a dependency and a
    // dependent would be fetched twice and rely on the merger to reconcile.
    const assign = (set: Set<string>, ...higher: Set<string>[]) =>
      Array.from(set).filter((p) => !higher.some((h) => h.has(p)));

    const changedPaths = Array.from(changedSet);
    // Changed files already fully covered by PR-head enclosing code: fetching
    // their pre-change default-branch chunks too would show the model a stale
    // second copy of the same code. They stay in changedSet above, so their
    // callers, dependencies and tests are still found exactly as before.
    const fullyHeadCovered = new Set(extra?.fullyHeadCoveredFiles ?? []);
    const changedPathsForChunkFetch = changedPaths.filter((p) => !fullyHeadCovered.has(p));
    const testPaths = assign(testSet, changedSet);
    const dependentPaths = assign(dependentSet, changedSet, testSet);
    const dependencyPaths = assign(dependencySet, changedSet, testSet, dependentSet);

    trace.fileSets = {
      changed: changedPaths.length,
      tests: testPaths.length,
      dependents: dependentPaths.length,
      dependencies: dependencyPaths.length,
      fanInSuppressed,
    };
    trace.timingMs.graphExpansion = performance.now() - t0;
    t0 = performance.now();

    // ---- STAGE B: fetch CODE for each structural class, in parallel.
    // threshold 0 throughout: a caller matters whether or not it happens to
    // embed near the PR title. Recall is bounded by count and budget only.
    const inFiles = (paths: string[], total: number) =>
      semanticRetrievalService.searchCodeChunksInFiles(
        repositoryId, queryVectorStr, paths, REVIEW_LIMITS.perFileChunkLimit, total, 0,
      );

    // ---- STAGE C: global semantic, EXCLUDING changed files (already covered
    // by the changed class — they must not double-enter as semantic_chunk).
    const [changedChunks, testChunks, dependentChunks, dependencyChunks, semanticChunks, reviewDocChunks] =
      await Promise.all([
        inFiles(changedPathsForChunkFetch, REVIEW_LIMITS.changedTotalLimit),
        inFiles(testPaths, REVIEW_LIMITS.testTotalLimit),
        inFiles(dependentPaths, REVIEW_LIMITS.dependentTotalLimit),
        inFiles(dependencyPaths, REVIEW_LIMITS.dependencyTotalLimit),
        semanticRetrievalService.searchCodeChunks(
          repositoryId,
          queryVectorStr,
          { ...options, maxCodeChunks: REVIEW_LIMITS.semanticLimit },
          undefined,
          changedPaths,
        ),
        // ---- STAGE D: documentation, using its own vector (see above)
        skipDocumentation
          ? Promise.resolve([])
          : semanticRetrievalService.searchDocumentationChunks(
              repositoryId,
              docVectorStr ?? queryVectorStr,
              options.maxDocChunks ?? DEFAULT_OPTIONS.maxDocChunks,
              options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold,
            ),
      ]);

    for (const c of changedChunks) {
      rawCandidates.push(this.chunkToCandidate(c, "changed_file"));
      trace.counts.changedFile++;
    }
    for (const c of testChunks) {
      rawCandidates.push(this.chunkToCandidate(c, "related_test"));
      trace.counts.relatedTest++;
    }
    for (const c of dependentChunks) {
      rawCandidates.push(this.chunkToCandidate(c, "graph_dependent"));
      trace.counts.graphDependent++;
    }
    for (const c of dependencyChunks) {
      rawCandidates.push(this.chunkToCandidate(c, "graph_dependency"));
      trace.counts.graphDependency++;
    }
    for (const c of semanticChunks) {
      rawCandidates.push(this.chunkToCandidate(c, "semantic_chunk"));
      trace.counts.semantic++;
    }

    // "Blind" means no structural signal at all. Computed over files that
    // could HAVE structure: an all-new-files PR has no indexed dependents by
    // definition and shouldn't be reported as a retrieval failure.
    const usedFallback =
      dependentPaths.length === 0 &&
      dependencyPaths.length === 0 &&
      changedChunks.length === 0 &&
      fullyHeadCovered.size === 0;

    docRetrievalLog(
      `Review structural expansion for repo ${repositoryId}: ` +
        `${changedPaths.length} changed / ${testPaths.length} test / ` +
        `${dependentPaths.length} dependent / ${dependencyPaths.length} dependency file(s) -> ` +
        `${changedChunks.length}/${testChunks.length}/${dependentChunks.length}/${dependencyChunks.length} chunk(s), ` +
        `${semanticChunks.length} semantic.` +
        (fanInSuppressed.length > 0
          ? ` Fan-in suppressed for: ${fanInSuppressed.join(", ")}.`
          : ""),
    );

    // Documentation is relevance-gated (fetched in the Promise.all above) and
    // deliberately kept OUT of the candidate merge/rerank/budget pipeline:
    // that pipeline allocates a code-context budget, and documentation is a
    // different kind of evidence with its own much smaller cap applied at
    // prompt-build time.
    //
    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    docRetrievalLog(
      `Review retrieval for repo ${repositoryId}: ${reviewDocChunks.length} doc section(s) matched ` +
        `the PR query (changed files: ${changedFiles.length}).`,
    );
    reviewDocChunks.forEach((d, i) => {
      docRetrievalLog(
        `  [Review Doc ${i + 1}] ${d.filePath} § "${d.sectionPath}" ` +
          `sim=${Number(d.similarity).toFixed(4)} :: ${docPreview(d.content)}`,
      );
    });

    trace.counts.totalPreMerge = rawCandidates.length;

    trace.timingMs.semanticRetrieval = performance.now() - t0;
    t0 = performance.now();

    // Stage 5: Merge & Deduplicate
    const mergeResult = candidateMergerService.mergeCandidates(rawCandidates);
    let candidates = mergeResult.candidates;
    trace.droppedCandidates.push(...mergeResult.dropped);
    trace.counts.totalPostMerge = candidates.length;

    // Stage 6: Rerank
    candidates = retrievalRerankerService.rerankCandidates(candidates);

    trace.timingMs.mergeAndRerank = performance.now() - t0;
    t0 = performance.now();

    // Stage 7: Context Budgeting
    const budgetResult = contextBudgetService.allocateBudget(candidates, options.maxTokens || 15000);
    const finalCandidates = budgetResult.accepted;
    
    trace.droppedCandidates.push(...budgetResult.dropped);
    trace.counts.finalAccepted = finalCandidates.length;
    trace.budget = budgetResult.budget;

    trace.timingMs.budgetAllocation = performance.now() - t0;
    trace.timingMs.total = performance.now() - startTime;

    // Finally: Format as RetrievedContext for consumer compatibility
    const context: RetrievedContext = {
      repositoryProfile: null,
      codeChunks: [],
      docChunks: reviewDocChunks,
      metadata: { mode: "review", usedFallback, query, trace },
    };

    // Every candidate is a code chunk now — the file_summary branch and the
    // post-budget changed-file-summary append that used to live here are both
    // gone. Both wrote into context.files, which the review prompt never read.
    for (const c of finalCandidates) {
      context.codeChunks.push({
        filePath: c.metadata.filePath!,
        symbolName: c.metadata.symbolName!,
        symbolType: primarySource(c)?.type ?? "unknown",
        content: c.content,
        lineStart: c.metadata.startLine!,
        lineEnd: c.metadata.endLine!,
        similarity: c.score,
      });
    }

    // Repository-level orientation: the deterministic, SHA-keyed profile, so
    // it is present on every review and always describes the indexed revision.
    context.repositoryProfile = (await repositoryMapService.getRepositoryProfile(repositoryId)).text || null;

    return context;
  }

  private chunkToCandidate(chunk: CodeChunkSearchResult, sourceType: keyof typeof RETRIEVAL_WEIGHTS): RetrievalCandidate {
    return {
      identityKey: `${chunk.filePath}#${chunk.lineStart}-${chunk.lineEnd}`,
      content: chunk.content,
      dataType: "code_chunk",
      sources: [{ type: sourceType, weight: RETRIEVAL_WEIGHTS[sourceType], similarity: chunk.similarity }],
      score: 0,
      metadata: {
        filePath: chunk.filePath,
        startLine: chunk.lineStart,
        endLine: chunk.lineEnd,
        symbolName: chunk.symbolName
      }
    };
  }
}

export const retrievalService = new RepositoryRetrievalService();
