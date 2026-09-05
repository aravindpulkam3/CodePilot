import { repositorySyncService } from "./repositorySync.service.js";
import { syncQueue } from "../config/queues.js";
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
} from "../types/retrievalTypes.js";
import {
  ArchitectureSummary,
  ComponentSummary,
  FileSummary,
  RepositorySummary,
} from "../types/summaryTypes.js";
import { InterviewState, MAX_TURNS_ON_MODULE } from "../types/interviewTypes.js";

import { semanticRetrievalService } from "./semanticRetrieval.service.js";
import { repositoryGraphService } from "./repositoryGraph.service.js";
import { relatedTestDiscoveryService } from "./relatedTestDiscovery.service.js";
import { candidateMergerService } from "./candidateMerger.service.js";
import { retrievalRerankerService, primarySource } from "./retrievalReranker.service.js";
import { contextBudgetService } from "./contextBudget.service.js";
import { pool } from "../config/db.js";
import { performance } from "perf_hooks";
import { initialModuleFor } from "./moduleDiscovery.service.js";
import { granularityOf } from "./interviewFocusResolution.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docRetrievalLog, docPreview } from "../utils/readmeDebugLog.js";

const DEFAULT_OPTIONS: RetrievalOptions = {
  maxComponents: 3,
  maxFiles: 5,
  maxCodeChunks: 10,
  similarityThreshold: 0.6,
  maxTokens: 15000,
  // Documentation starts at the same threshold as code for consistency, but
  // is a separate knob so it can be retuned independently — code chunks and
  // prose don't necessarily share a similarity distribution.
  maxDocChunks: 3,
  docSimilarityThreshold: 0.6,
};

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
   * Blocks retrieval until the repository reaches SEARCHABLE — or throws.
   * Gated on `searchable_at`, not full readiness: Q&A/Review/Interview are
   * usable the moment Phase 1 (sync/parse/embed/import-graph) finishes,
   * regardless of whether Phase 2's background LLM summarization
   * (SUMMARIZING/READY) has caught up yet. Summarization is sequential
   * Ollama and can legitimately take far longer than any HTTP request
   * budget — blocking retrieval on it would defeat the entire point of the
   * SEARCHABLE/READY split.
   *
   * Previously this waited on full `indexing_status === 'INDEXED'`
   * (summarization included) with a single 45s budget that, when it ran
   * out, just logged and returned anyway regardless of real state — reviews
   * /QA/interview answers were routinely generated against a partially- or
   * un-indexed repo, silently. The fix here is NOT "wait longer" on its own
   * — this still runs inline on a synchronous HTTP request (POST /reviews,
   * chat stream, interview start), so blocking for minutes would just trade
   * a silently-wrong result for a hung request/proxy timeout. Instead: keep
   * the wait bounded to Phase 1 (fast) and request-friendly, and when the
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

    // 1. Enqueue the sync job, then wait for THIS job to finish (not just any past
    // state) before looking at searchable_at — the repo can already read
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
    // Poll the repo's searchable_at/indexing_status until Phase 1 finishes.
    const { pool } = await import("../config/db.js");

    while (deadline()) {
      const { rows } = await pool.query(
        "SELECT searchable_at, indexing_status FROM repositories WHERE id = $1",
        [repositoryId]
      );

      const searchableAt = rows[0]?.searchable_at;
      const status = rows[0]?.indexing_status;

      if (searchableAt) {
        console.log(`[RetrievalService] Repository ${repositoryId} is searchable (status: ${status}).`);
        return;
      }

      if (status === 'FAILED') {
        console.error(`[RetrievalService] Repository ${repositoryId} indexing FAILED — refusing to retrieve on a broken index.`);
        throw new Error('INDEXING_FAILED');
      }

      // status is NOT_STARTED / SYNCING / INDEXING — still in progress, keep waiting.
      await new Promise(res => setTimeout(res, pollIntervalMs));
    }

    console.error(
      `[RetrievalService] Timed out after ${maxWaitMs / 1000}s waiting for repository ${repositoryId} to become searchable — refusing to retrieve on a partial index.`,
    );
    throw new Error('INDEXING_IN_PROGRESS');
  }

  /**
   * Read-only readiness check — no sync enqueue, no polling, no GitHub round
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
      "SELECT searchable_at, indexing_status FROM repositories WHERE id = $1",
      [repositoryId],
    );
    const searchableAt = rows[0]?.searchable_at;
    const status = rows[0]?.indexing_status ?? "NOT_STARTED";

    if (searchableAt) return;

    if (status === "FAILED") {
      console.error(`[RetrievalService] Repository ${repositoryId} indexing FAILED — refusing to retrieve on a broken index.`);
      throw new Error("INDEXING_FAILED");
    }

    console.warn(`[RetrievalService] Repository ${repositoryId} is not searchable (status: ${status}) — refusing this turn.`);
    throw new Error("INDEXING_IN_PROGRESS");
  }

  // --- QA Mode ---
  public async retrieveQAContext(clerkUserId: string, repositoryId: string, query: string, opts?: RetrievalOptions): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSearchable(clerkUserId, repositoryId);

    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(query);

    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      docChunks: [],
      metadata: { mode: "qa", usedFallback: false, query },
    };

    const summaryResults = await semanticRetrievalService.searchSummaries(
      repositoryId,
      queryVectorStr,
      undefined,
      10,
      options.similarityThreshold,
    );

    let relevantFilePaths = new Set<string>();

    // Authoritative file paths, pushed in lockstep with context.files so the
    // chunk scope can be re-derived after slicing (below).
    //
    // These MUST be node_key, not summary_json.path: `path` is a required
    // field in generateFileSummary's output schema, i.e. the LLM writes it,
    // and it can drift from the real path (abbreviated, prefixed, or simply
    // wrong). node_key is the value the row is stored and looked up under,
    // and is what repository_embeddings.file_path is matched against.
    const relevantFilePathsInOrder: string[] = [];

    for (const res of summaryResults) {
      // Repository- and architecture-level hits were previously retrieved
      // here (searchSummaries is called with nodeType undefined) and then
      // silently dropped, because only the file/component branches existed.
      // Those are exactly the rows that answer "what does this project do",
      // so capture them instead of discarding them.
      if (res.nodeType === "repository") {
        if (!context.repository) context.repository = res.summary as RepositorySummary;
      } else if (res.nodeType === "architecture") {
        if (!context.architecture) context.architecture = res.summary as ArchitectureSummary;
      } else if (res.nodeType === "file") {
        context.files.push(res.summary as FileSummary);
        relevantFilePaths.add(res.nodeKey);
        relevantFilePathsInOrder.push(res.nodeKey);
      } else if (
        res.nodeType === "component" &&
        context.components.length < (options.maxComponents || 3)
      ) {
        context.components.push(res.summary as ComponentSummary);
        const childFiles = await semanticRetrievalService.resolveComponentFiles(
          repositoryId,
          res.nodeKey,
        );
        const fileLimit = options.maxFiles || 5;
        let added = 0;
        for (const cf of childFiles) {
          if (added >= fileLimit) break;
          if (!relevantFilePaths.has(cf.nodeKey)) {
            context.files.push(cf.summary as FileSummary);
            relevantFilePaths.add(cf.nodeKey);
            relevantFilePathsInOrder.push(cf.nodeKey);
            added++;
          }
        }
      }
    }

    context.components = context.components.slice(0, options.maxComponents);
    context.files = context.files.slice(0, options.maxFiles);

    // Re-derive the chunk scope from the files actually kept. Previously the
    // display list was sliced but chunk retrieval still used the full
    // unsliced set (up to 10 + maxComponents x maxFiles paths), so chunks
    // could come from files the caller never saw. Sliced identically to
    // context.files above, and built from node_key — see the note where
    // relevantFilePathsInOrder is declared.
    relevantFilePaths = new Set(
      relevantFilePathsInOrder.slice(0, options.maxFiles ?? DEFAULT_OPTIONS.maxFiles),
    );

    // Documentation and code are searched concurrently — two pgvector reads
    // against the SAME already-computed query vector. This is database I/O
    // parallelism only: no LLM call, no classifier, and nothing here relaxes
    // the strictly-sequential Ollama summarization worker.
    //
    // Routing between docs and code is emergent rather than decided up front:
    // both are gated by their own threshold and whichever genuinely matches
    // the question wins. "How do I run this" surfaces README setup sections;
    // "how is auth implemented" surfaces code.
    const [docChunks, scopedCodeChunks] = await Promise.all([
      semanticRetrievalService.searchDocumentationChunks(
        repositoryId,
        queryVectorStr,
        options.maxDocChunks ?? DEFAULT_OPTIONS.maxDocChunks,
        options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold,
      ),
      relevantFilePaths.size === 0
        ? semanticRetrievalService.searchCodeChunks(repositoryId, queryVectorStr, options)
        : semanticRetrievalService.searchCodeChunks(
            repositoryId,
            queryVectorStr,
            options,
            Array.from(relevantFilePaths),
          ),
    ]);

    let codeChunks = scopedCodeChunks;

    if (relevantFilePaths.size === 0) {
      context.metadata.usedFallback = true;
    } else if (codeChunks.length === 0) {
      // The path restriction starved the answer: file summaries matched, so
      // chunks were scoped to those files, but none of THEIR chunks cleared
      // the threshold — leaving the model with no code at all.
      //
      // This is the recall ceiling of scoping chunks by summary hits: a
      // highly relevant chunk in a file whose *summary* scored below
      // threshold is unreachable. Observed live — a repo returned 10 chunks
      // via the unrestricted path while still SUMMARIZING, then 0 once its
      // summaries existed and narrowed the scope to two unrelated files.
      //
      // Rather than change the scoping (which is usually a precision win),
      // treat an empty scoped result as no better than having no scope at
      // all, and redo the search repo-wide.
      context.metadata.usedFallback = true;
      codeChunks = await semanticRetrievalService.searchCodeChunks(
        repositoryId,
        queryVectorStr,
        options,
      );
      docRetrievalLog(
        `  Scoped code search returned 0 chunks from [${Array.from(relevantFilePaths).join(", ")}] ` +
          `— retried repo-wide, got ${codeChunks.length}.`,
      );
    }

    context.docChunks = docChunks;
    context.codeChunks = codeChunks;

    console.log(
      `[Retrieval] QA for ${repositoryId}: ${codeChunks.length} code chunk(s), ${docChunks.length} doc section(s), repoSummary=${!!context.repository}.`,
    );

    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    docRetrievalLog(
      `Q&A query="${docPreview(query, 80)}" -> ${docChunks.length} doc section(s), ` +
        `${codeChunks.length} code chunk(s), repoSummary=${!!context.repository}, ` +
        `docThreshold=${options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold}.`,
    );
    docRetrievalLog(
      `  Code scope: ${
        relevantFilePaths.size === 0
          ? "UNRESTRICTED (no file summaries matched — repo-wide fallback)"
          : `${relevantFilePaths.size} file(s) [${Array.from(relevantFilePaths).join(", ")}]`
      }`,
    );
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

    return context;
  }

  // --- Interview Mode: Coverage-driven retrieval ---
  /**
   * Repository-only, Phase-1-only, non-LLM orientation primitive: groups
   * every indexed file by `initialModuleFor` and ranks both the modules and
   * the files within each by summed import fan-in. This is what lets the
   * opening question (and later NEW_TOPIC turns) be genuinely
   * repository-specific — "this repo has areas for Auth, Rate Limiting, and
   * URL persistence" — with zero README and zero LLM summaries required,
   * which is exactly the state an interview is most likely to start in.
   */
  private async buildModuleInventory(repositoryId: string): Promise<ModuleInventoryEntry[]> {
    const [allFiles, fanIn] = await Promise.all([
      semanticRetrievalService.listIndexedFilePaths(repositoryId),
      repositoryGraphService.getImportFanInCounts(repositoryId),
    ]);

    const byModule = new Map<string, string[]>();
    for (const file of allFiles) {
      const module = initialModuleFor(file);
      const files = byModule.get(module);
      if (files) files.push(file);
      else byModule.set(module, [file]);
    }

    const entries: ModuleInventoryEntry[] = Array.from(byModule.entries()).map(([module, files]) => {
      const ranked = [...files].sort((a, b) => (fanIn.get(b) ?? 0) - (fanIn.get(a) ?? 0));
      return { module, fileCount: ranked.length, files: ranked };
    });

    entries.sort((a, b) => {
      const fanInA = a.files.reduce((sum, f) => sum + (fanIn.get(f) ?? 0), 0);
      const fanInB = b.files.reduce((sum, f) => sum + (fanIn.get(f) ?? 0), 0);
      if (fanInB !== fanInA) return fanInB - fanInA;
      return b.fileCount - a.fileCount;
    });

    return entries;
  }

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
   * (real, Phase-1-only) plus whatever of {repository, architecture,
   * docChunks} happens to be available — never an arbitrary code snippet.
   */
  public async retrieveInterviewStartContext(clerkUserId: string, repositoryId: string, opts?: RetrievalOptions): Promise<InterviewStartContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSearchable(clerkUserId, repositoryId);

    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(
      "What does this project do? Explain its architecture, main components, and how it's structured.",
    );

    const [moduleInventory, docChunks, statusRes] = await Promise.all([
      this.buildModuleInventory(repositoryId),
      semanticRetrievalService.searchDocumentationChunks(
        repositoryId, queryVectorStr,
        options.maxDocChunks ?? DEFAULT_OPTIONS.maxDocChunks,
        options.docSimilarityThreshold ?? DEFAULT_OPTIONS.docSimilarityThreshold,
      ),
      pool.query(`SELECT indexing_status FROM repositories WHERE id = $1`, [repositoryId]),
    ]);

    // Repository/architecture summaries: enrichment only, and ONLY when the
    // repo is fully caught up. Not READY -> omit entirely, same reasoning as
    // retrieveReviewContext — a summary may describe an older revision than
    // the code retrieved alongside it while SEARCHABLE-but-not-READY, and
    // silence beats presenting a stale summary as current.
    let repository: RepositorySummary | null = null;
    let architecture: ArchitectureSummary | null = null;
    if (statusRes.rows[0]?.indexing_status === "READY") {
      const [repoSummaries, archSummaries] = await Promise.all([
        semanticRetrievalService.listSummariesByType(repositoryId, "repository", 1),
        semanticRetrievalService.listSummariesByType(repositoryId, "architecture", 1),
      ]);
      if (repoSummaries.length > 0) repository = repoSummaries[0].summary as RepositorySummary;
      if (archSummaries.length > 0) architecture = archSummaries[0].summary as ArchitectureSummary;
    }

    const contextPaths = moduleInventory.flatMap((m) => m.files);
    const contextModules = moduleInventory.map((m) => m.module);

    console.log(
      `[INTERVIEW-RETRIEVAL] start repo=${repositoryId}: 0 code chunks (v2 — code is fetched only ` +
        `once focus narrows to FILE granularity), ${moduleInventory.length} module(s) ` +
        `[${contextModules.join(", ")}], ${docChunks.length} doc section(s), repoSummary=${!!repository} ` +
        `architecture=${!!architecture} (READY-gated).`,
    );

    return { repository, architecture, moduleInventory, docChunks, contextPaths, contextModules };
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

    const moduleInventoryPromise = this.buildModuleInventory(repositoryId);

    const [
      moduleInventory,
      stayDocVectorStr,
      statusRes,
    ] = await Promise.all([
      moduleInventoryPromise,
      stayDocVectorPromise,
      pool.query(`SELECT indexing_status FROM repositories WHERE id = $1`, [repositoryId]),
    ]);
    const isReady = statusRes.rows[0]?.indexing_status === "READY";

    // GROUNDING — keyed on the QUESTION, never the answer. Restricted to
    // the CURRENT granularity's real material: code only at FILE, since a
    // MODULE/REPOSITORY-scope question wasn't about specific code and there
    // is nothing to check the answer against.
    let groundingCode: CodeChunkSearchResult[] = [];
    let groundingDocsPromise: Promise<DocChunkSearchResult[]>;
    let groundingSummaryPromise: Promise<RepositorySummary | ArchitectureSummary | ComponentSummary | null>;

    // STAY — deeper material at the unchanged granularity.
    let stayCode: CodeChunkSearchResult[] = [];
    let stayDocsPromise: Promise<DocChunkSearchResult[]> = Promise.resolve([]);
    let staySummaryPromise: Promise<ArchitectureSummary | ComponentSummary | null> = Promise.resolve(null);

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
      groundingSummaryPromise = Promise.resolve(null);
      // No NARROW at FILE — nothing finer than an implementation to offer.
    } else if (granularity === "MODULE" && focusModule) {
      groundingDocsPromise = semanticRetrievalService.searchDocumentationChunks(
        repositoryId, questionVectorStr, INTERVIEW_LIMITS.groundingDocLimit, DEFAULT_OPTIONS.docSimilarityThreshold,
      );
      const componentSummaryPromise: Promise<ComponentSummary | null> = isReady
        ? semanticRetrievalService
            .getComponentSummaries(repositoryId, [focusModule])
            .then((rows) => (rows.length > 0 ? (rows[0].summary as ComponentSummary) : null))
        : Promise.resolve(null);
      groundingSummaryPromise = componentSummaryPromise;
      staySummaryPromise = componentSummaryPromise;

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
      const architecturePromise: Promise<ArchitectureSummary | null> = isReady
        ? semanticRetrievalService
            .listSummariesByType(repositoryId, "architecture", 1)
            .then((rows) => (rows.length > 0 ? (rows[0].summary as ArchitectureSummary) : null))
        : Promise.resolve(null);
      const repositorySummaryPromise: Promise<RepositorySummary | null> = isReady
        ? semanticRetrievalService
            .listSummariesByType(repositoryId, "repository", 1)
            .then((rows) => (rows.length > 0 ? (rows[0].summary as RepositorySummary) : null))
        : Promise.resolve(null);
      groundingSummaryPromise = repositorySummaryPromise;
      staySummaryPromise = architecturePromise;

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

    const [groundingDocs, groundingSummary, stayDocs, staySummary] = await Promise.all([
      groundingDocsPromise, groundingSummaryPromise, stayDocsPromise, staySummaryPromise,
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
        `${groundingSummary ? "1" : "0"}summary, stay ${stayCode.length}code/${stayDocs.length}doc/` +
        `${staySummary ? "1" : "0"}summary, narrow ${narrowModules.length}module/${narrowFiles.length}file, ` +
        `frontier ${frontierModules.length}module (${wantsFrontierLarge ? "large" : "small"}), ` +
        `query="${docPreview(question, 80)}".`,
    );

    return {
      granularity,
      groundingCode, groundingDocs, groundingSummary,
      stayCode, stayDocs, staySummary,
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
   * The governing rule: the GRAPH decides WHICH files matter, then pgvector
   * fetches their CODE. Previously the structural stages fetched
   * `getFileSummaries()` — LLM prose from `repository_summaries` — which
   * (a) is written only by Phase 2, so it was empty during SEARCHABLE, when
   * review is most likely to run, and (b) landed in `context.files`, which the
   * review prompt never read. All of that work was computed, charged 60% of
   * the token budget, allowed to evict real code, and then discarded.
   */
  public async retrieveReviewContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    changedFiles: string[],
    opts?: RetrievalOptions,
    /**
     * Separate query for documentation retrieval. Code retrieval wants the
     * changed file list; prose retrieval is actively harmed by it (a README's
     * file-tree section outscores its behaviour sections). Pass null to skip
     * documentation entirely — see buildDocumentationQuery. Omitting the
     * argument falls back to `query`, preserving the old behaviour for any
     * other caller.
     */
    docQuery?: string | null,
  ): Promise<RetrievedContext> {
    const startTime = performance.now();
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSearchable(clerkUserId, repositoryId);

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
      repository: null, architecture: null, components: [], files: [],
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

    for (const file of expansionFiles) {
      const [deps, dependents] = await Promise.all([
        repositoryGraphService.getDirectDependencies(repositoryId, file),
        repositoryGraphService.getDirectDependents(repositoryId, file),
      ]);

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
        inFiles(changedPaths, REVIEW_LIMITS.changedTotalLimit),
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
      dependentPaths.length === 0 && dependencyPaths.length === 0 && changedChunks.length === 0;

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
      repository: null,
      architecture: null,
      components: [],
      files: [],
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

    // Repository-level orientation, ONLY when the repo is fully caught up.
    // Deliberately not a file or component summary: those describe individual
    // functions and go stale fast, and while a repo is SEARCHABLE-but-not-READY
    // they sit at last_summarized_sha while the code sits at last_indexed_sha.
    // A repository summary ("a Node/Express backend with a BullMQ worker")
    // survives that drift; a file summary does not. Silence beats a stale
    // summary presented as current.
    const { rows: statusRows } = await pool.query(
      `SELECT indexing_status FROM repositories WHERE id = $1`,
      [repositoryId],
    );
    if (statusRows[0]?.indexing_status === "READY") {
      const repoSummaries = await semanticRetrievalService.listSummariesByType(repositoryId, "repository", 1);
      if (repoSummaries.length > 0) {
        context.repository = repoSummaries[0].summary as RepositorySummary;
      }
    }

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

  // summaryToCandidate() was removed with the file_summary path: it wrapped
  // repository_summaries prose as a retrieval candidate, which (a) was empty
  // during SEARCHABLE, (b) was charged against the code token budget, and
  // (c) was never read by the review prompt.
}

export const retrievalService = new RepositoryRetrievalService();
