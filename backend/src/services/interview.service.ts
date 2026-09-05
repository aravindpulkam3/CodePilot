import { pool } from "../config/db.js";
import { llmService, LLMMessage, ollamaService } from "./llm.service.js";
import { retrievalService } from "./retreival.service.js";
import { Type, Schema } from "@google/genai";
import {
  InterviewConfig,
  InterviewState,
  InterviewFocus,
  InterviewAction,
  InterviewTurnEvaluation,
  InterviewFinalAssessment,
  InterviewNextFocus,
} from "../types/interviewTypes.js";
import { interviewPromptBuilder } from "../promptBuilders/interviewPromptBuilder.js";
import { activityLogService } from "./activityLog.service.js";
import { semanticRetrievalService } from "./semanticRetrieval.service.js";
import { initialModuleFor } from "./moduleDiscovery.service.js";
import {
  resolvePathAgainstList,
  resolveModuleAgainstList,
  checkActionFocusConsistency,
} from "./interviewFocusResolution.js";

/** Bounded recent transcript sent per turn — replaces the previous unbounded
 * SELECT. Older turns are represented by state.knownGaps instead of raw
 * text, so per-turn prompt size stays flat as the interview grows rather
 * than scaling with its length. */
const INTERVIEW_HISTORY_LIMIT = 12;

const INTERVIEW_STATE_LIMITS = {
  maxKnownGaps: 8,
  maxTopicsCovered: 20,
};

const interviewEvaluationSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.NUMBER, description: "Score from 0-10" },
    answerQuality: {
      type: Type.STRING,
      enum: ["poor", "weak", "adequate", "strong", "excellent"],
    },
    technicalAccuracy: { type: Type.NUMBER, description: "Score from 0-10" },
    depthOfUnderstanding: { type: Type.NUMBER, description: "Score from 0-10" },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
    missingConcepts: { type: Type.ARRAY, items: { type: Type.STRING } },
    topic: {
      type: Type.STRING,
      description:
        "Short human-readable label for the subject of the NEXT question (e.g. 'JWT validation'). " +
        "Display only — NOT used to decide repetition. See nextFocus for the actual dedupe key.",
    },
    nextAction: {
      type: Type.STRING,
      enum: ["FOLLOW_UP", "DEEP_DIVE", "SIMPLIFY", "NEW_TOPIC"],
      description:
        "FOLLOW_UP: the answer was partially correct or missed specific concepts — probe the gap, " +
        "same focus. DEEP_DIVE: the answer was strong/excellent — go deeper on the same focus " +
        "(dependency, edge case, tradeoff). SIMPLIFY: the answer was poor/weak — drop difficulty and " +
        "test a prerequisite, same focus. NEW_TOPIC: this focus is sufficiently covered, or you were " +
        "told the turn limit on it was reached — move to unvisited material.",
    },
    nextDifficulty: {
      type: Type.STRING,
      enum: ["easy", "medium", "hard"],
    },
    nextFocus: {
      type: Type.OBJECT,
      description:
        "The target the NEXT question is grounded in, at one of three granularities. filePath: an " +
        "exact-implementation question — MUST be exactly one of the paths explicitly listed in this " +
        "prompt's context, never invented or abbreviated. module: an area/component-level question " +
        "with no single file chosen yet — MUST be exactly one of the module names explicitly listed " +
        "in this prompt's context, never invented. Both null: a genuinely repository-wide question " +
        "(e.g. 'walk me through the architecture') with no narrower target. Set at most one of " +
        "filePath/module — if filePath is set, leave module null (it is derived automatically).",
      properties: {
        filePath: { type: Type.STRING, nullable: true },
        module: { type: Type.STRING, nullable: true },
        symbolName: { type: Type.STRING, nullable: true },
        reason: { type: Type.STRING, description: "One short clause: why this is the target." },
      },
      required: ["filePath", "module", "symbolName", "reason"],
    },
    correction: {
      type: Type.OBJECT,
      description:
        "Structured internal record of any factual correction — kept for bookkeeping, NOT shown to " +
        "the candidate verbatim. When needed is true, interviewerMessage below must weave this " +
        "substance in conversationally, in your own words — never as a separate labeled block.",
      properties: {
        needed: { type: Type.BOOLEAN },
        explanation: { type: Type.STRING },
        keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["needed", "explanation", "keyPoints"],
    },
    // Declared LAST deliberately: by the time you write this, the evaluation,
    // nextAction/nextFocus, and correction above are already decided — this
    // is where you synthesize all of it into the one thing you'd actually
    // say next. See the "How to respond" section in the prompt for the full
    // behavioral contract — this is NOT a bare question field.
    interviewerMessage: {
      type: Type.STRING,
      description:
        "Your entire next spoken turn, exactly as you'd say it aloud — not just a question. May open " +
        "with a brief reaction to what the candidate just said, or may not (omitting any reaction and " +
        "asking a direct question is often the right choice — do not default to a reaction-then-question " +
        "template every turn). Flows as ONE continuous thought, never stapled parts. Weave in a " +
        "correction conversationally when correction.needed is true — no bullet points, no 'Corrective " +
        "Feedback' heading. Must never mention score, evaluation labels, retrieval, or repository coverage.",
    },
  },
  required: [
    "score",
    "answerQuality",
    "technicalAccuracy",
    "depthOfUnderstanding",
    "strengths",
    "weaknesses",
    "missingConcepts",
    "topic",
    "nextAction",
    "nextDifficulty",
    "nextFocus",
    "correction",
    "interviewerMessage",
  ],
};

export const interviewFinalAssessmentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    overallAssessment: { type: Type.STRING },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
    score: { type: Type.NUMBER, description: "Score from 0-10" },
  },
  required: ["overallAssessment", "strengths", "weaknesses", "score"],
};

const EMPTY_FOCUS: InterviewFocus = { filePath: null, symbolName: null, module: null };

/**
 * Defensive defaults for `chat_sessions.state`. Handles two cases: a row
 * written by the now-deleted chat-provider path (Path B), which left
 * `state = '{}'` and crashed on `state.topicsCovered.join()`; and any
 * session created before this module's state shape changed. Never throws —
 * every field has a safe default.
 */
function withStateDefaults(raw: any): InterviewState {
  const r = raw || {};
  return {
    currentTopic: typeof r.currentTopic === "string" ? r.currentTopic : "Overview",
    topicsCovered: Array.isArray(r.topicsCovered) ? r.topicsCovered : [],
    currentFocus: r.currentFocus && typeof r.currentFocus === "object" ? r.currentFocus : EMPTY_FOCUS,
    visitedFiles: Array.isArray(r.visitedFiles) ? r.visitedFiles : [],
    visitedModules: Array.isArray(r.visitedModules) ? r.visitedModules : [],
    turnsOnCurrentFocus: typeof r.turnsOnCurrentFocus === "number" ? r.turnsOnCurrentFocus : 0,
    turnsOnCurrentModule: typeof r.turnsOnCurrentModule === "number" ? r.turnsOnCurrentModule : 0,
    lastAction: r.lastAction ?? "INITIAL",
    difficulty: r.difficulty === "easy" || r.difficulty === "medium" || r.difficulty === "hard" ? r.difficulty : "medium",
    difficultyMode: r.difficultyMode ?? (r.difficulty ?? "medium"),
    knownGaps: Array.isArray(r.knownGaps) ? r.knownGaps : [],
    questionCount: typeof r.questionCount === "number" ? r.questionCount : 0,
    assessment: r.assessment,
  };
}

export class InterviewService {
  /**
   * Resolves the model's raw `nextFocus` declaration into a validated,
   * persistable InterviewFocus. Never trusts the model's raw path/module
   * verbatim — composes the pure ladders from interviewFocusResolution.ts
   * with real DB/repo lookups:
   *   1. filePath present -> resolvePathAgainstList (exact context match ->
   *      exact indexed match -> unique basename match -> reject)
   *   2. else module present -> resolveModuleAgainstList (exact context
   *      match -> exact inventory match -> case-insensitive match -> reject)
   *   3. neither present -> REPOSITORY scope, a legitimate declaration, not
   *      a rejection
   * Then, unless the turn resolved via NEW_TOPIC, checkActionFocusConsistency
   * (§2b) rejects a stay-action's cross-module jump — module kept, any
   * out-of-module filePath dropped.
   *
   * `pathRejected: true` is the caller's signal to keep state.currentFocus
   * unchanged and freeze (not increment) turnsOnCurrentFocus/Module — it
   * covers both an unresolvable filePath AND an unresolvable module, the
   * same "hallucinated identifier, keep previous state" outcome either way.
   * `moduleJumpRejected: true` means the identifier resolved fine, but a
   * stay-action tried to leave the persisted module — only the bookkeeping
   * is corrected, interviewerMessage/evaluation are still used exactly as
   * the model produced them.
   */
  private async resolveFocus(
    rawFocus: InterviewNextFocus | null | undefined,
    contextPaths: string[],
    contextModules: string[],
    repositoryId: string,
    action: InterviewAction,
    previousFocus: InterviewFocus,
  ): Promise<{ focus: InterviewFocus; pathRejected: boolean; moduleJumpRejected: boolean }> {
    const indexedPaths = await semanticRetrievalService.listIndexedFilePaths(repositoryId);

    const { resolvedPath, rejected: pathRejected } = resolvePathAgainstList(
      rawFocus?.filePath,
      contextPaths,
      indexedPaths,
    );

    if (pathRejected) {
      console.warn(
        `[Interview] focusRejected: model proposed unresolvable path "${rawFocus?.filePath}" ` +
          `(reason: ${rawFocus?.reason ?? "n/a"}). Keeping previous focus.`,
      );
      return { focus: previousFocus, pathRejected: true, moduleJumpRejected: false };
    }

    let resolvedFocus: InterviewFocus;

    if (resolvedPath) {
      // symbolName is validated loosely — dropped rather than failing the turn.
      let symbolName: string | null = null;
      if (rawFocus?.symbolName) {
        const { rows } = await pool.query(
          `SELECT 1 FROM repository_embeddings WHERE repository_id = $1 AND file_path = $2 AND symbol_name = $3 LIMIT 1`,
          [repositoryId, resolvedPath, rawFocus.symbolName],
        );
        if (rows.length > 0) symbolName = rawFocus.symbolName;
      }
      resolvedFocus = { filePath: resolvedPath, symbolName, module: initialModuleFor(resolvedPath) };
    } else {
      const allModules = Array.from(new Set(indexedPaths.map((p) => initialModuleFor(p))));
      const { resolvedModule, rejected: moduleRejected } = resolveModuleAgainstList(
        rawFocus?.module,
        contextModules,
        allModules,
      );

      if (moduleRejected) {
        console.warn(
          `[Interview] focusRejected: model proposed unresolvable module "${rawFocus?.module}" ` +
            `(reason: ${rawFocus?.reason ?? "n/a"}). Keeping previous focus.`,
        );
        return { focus: previousFocus, pathRejected: true, moduleJumpRejected: false };
      }

      resolvedFocus = { filePath: null, symbolName: null, module: resolvedModule };
    }

    const { focus, moduleJumpRejected } = checkActionFocusConsistency(action, resolvedFocus, previousFocus);
    return { focus, pathRejected: false, moduleJumpRejected };
  }

  public async startInterview(
    userId: string,
    config: InterviewConfig,
    clerkUserId?: string,
  ): Promise<{ sessionId: string; firstQuestion: string }> {
    if (!config.repositoryId) {
      throw new Error("repositoryId is required to start a repository interview.");
    }
    if (!clerkUserId) {
      throw new Error("clerkUserId is required to start a repository interview.");
    }

    // 1. Retrieve BEFORE creating any DB row. A failure here (including the
    // catchable INDEXING_IN_PROGRESS / INDEXING_FAILED) must never leave an
    // orphaned, message-less session in "Past Interviews".
    const seedContext = await retrievalService.retrieveInterviewStartContext(
      clerkUserId,
      config.repositoryId,
      { maxComponents: 5 },
    );

    // 2. Generate the first question.
    const messages = interviewPromptBuilder.buildStartPrompt(config, seedContext);
    const decision = await llmService.generateStructured<InterviewTurnEvaluation>(
      messages,
      interviewEvaluationSchema,
    );

    // 3. Validate the declared focus BEFORE persisting anything. No
    // previous focus exists yet on turn 1 (REPOSITORY scope), so §2b's
    // consistency check is a structural no-op here — it only ever fires
    // once a real previous module exists to jump away from.
    const { focus: resolvedFocus } = await this.resolveFocus(
      decision.nextFocus,
      seedContext.contextPaths,
      seedContext.contextModules,
      config.repositoryId,
      decision.nextAction,
      EMPTY_FOCUS,
    );

    // No code is retrieved for the opening turn (v2 — see
    // retrieveInterviewStartContext), so nothing is "visited" yet beyond
    // whatever the model's own resolved focus actually commits to. A
    // moduleInventory file/module NAME appearing in the prompt is not
    // exposure — only code the candidate has actually been asked about is.
    const visitedFiles = resolvedFocus.filePath ? [resolvedFocus.filePath] : [];
    const visitedModules = resolvedFocus.module ? [resolvedFocus.module] : [];

    const initialState: InterviewState = {
      currentTopic: decision.topic || "Overview",
      topicsCovered: [],
      currentFocus: resolvedFocus,
      visitedFiles,
      visitedModules,
      turnsOnCurrentFocus: 1,
      turnsOnCurrentModule: 1,
      lastAction: decision.nextAction,
      difficulty: config.difficulty === "adaptive" ? decision.nextDifficulty : config.difficulty,
      difficultyMode: config.difficulty,
      knownGaps: [],
      questionCount: 0,
    };

    // 4. Persist — session + first question together, atomically, only now
    // that the LLM call has already succeeded.
    const client = await pool.connect();
    let sessionId: string;
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO chat_sessions (user_id, repository_id, type, state)
         VALUES ($1, $2, 'INTERVIEW', $3)
         RETURNING id`,
        [userId, config.repositoryId, JSON.stringify(initialState)],
      );
      sessionId = rows[0].id;

      await client.query(
        `INSERT INTO chat_messages (session_id, role, content, metadata)
         VALUES ($1, 'assistant', $2, $3)`,
        [
          sessionId,
          decision.interviewerMessage,
          JSON.stringify({
            type: "question",
            topic: decision.topic,
            action: decision.nextAction,
            focus: resolvedFocus,
            evaluation: decision,
          }),
        ],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    await activityLogService.logEvent({
      userId,
      repositoryId: config.repositoryId,
      activityType: "INTERVIEW_STARTED",
      metadata: { sessionId, title: "Technical Interview" },
    });

    console.log(
      `[Interview] session=${sessionId} started. focus=${resolvedFocus.filePath ?? resolvedFocus.module ?? "(repository)"} ` +
        `modules=${seedContext.moduleInventory.length} repoSummary=${!!seedContext.repository}.`,
    );

    // `firstQuestion` is a legacy API field name kept for backwards
    // compatibility; it now holds the full next interviewer message (may
    // include a reaction, a woven-in correction, and/or a transition, not
    // just a bare question) — see `interviewerMessage` in
    // interviewEvaluationSchema for the source.
    return { sessionId, firstQuestion: decision.interviewerMessage };
  }

  public async processAnswer(
    sessionId: string,
    userId: string,
    answer: string,
  ): Promise<{ nextQuestion?: string; assessment?: any; correction?: any }> {
    const sessionRes = await pool.query(
      `SELECT repository_id, state FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (sessionRes.rows.length === 0) throw new Error("Session not found");
    const repositoryId = sessionRes.rows[0].repository_id;
    if (!repositoryId) throw new Error("Interview session has no associated repository.");
    const state = withStateDefaults(sessionRes.rows[0].state);

    // Bounded recent history — see INTERVIEW_HISTORY_LIMIT. Older turns are
    // represented by state.knownGaps rather than raw transcript text.
    const historyRes = await pool.query(
      `SELECT role, content FROM chat_messages WHERE session_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [sessionId, INTERVIEW_HISTORY_LIMIT],
    );
    const recentHistory: LLMMessage[] = historyRes.rows
      .reverse()
      .map((r) => ({ role: r.role, content: r.content }));

    const lastQuestion = [...recentHistory].reverse().find((m) => m.role === "assistant")?.content;
    if (!lastQuestion) {
      throw new Error("No prior question found for this interview session.");
    }

    // Save the user's answer.
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, metadata) VALUES ($1, 'user', $2, $3)`,
      [sessionId, answer, JSON.stringify({ type: "answer" })],
    );
    recentHistory.push({ role: "user", content: answer });

    // Retrieval is keyed on the QUESTION, not the answer — see
    // retreival.service.ts's retrieveInterviewFollowUpContext.
    const followUpContext = await retrievalService.retrieveInterviewFollowUpContext(
      repositoryId,
      lastQuestion,
      state,
    );

    const messages = interviewPromptBuilder.buildFollowUpPrompt(state, recentHistory, followUpContext);

    const decision = await llmService.generateStructured<InterviewTurnEvaluation>(
      messages,
      interviewEvaluationSchema,
    );

    // Validate the declared focus for the NEXT question before persisting.
    // §2b's action/focus consistency check runs inside resolveFocus and may
    // reject a stay-action's cross-module jump independently of whether the
    // identifier itself resolved to something real.
    const {
      focus: effectiveFocus,
      pathRejected,
      moduleJumpRejected,
    } = await this.resolveFocus(
      decision.nextFocus,
      followUpContext.contextPaths,
      followUpContext.contextModules,
      repositoryId,
      decision.nextAction,
      state.currentFocus,
    );

    // Bound counters are derived from FOCUS IDENTITY, not the model's
    // self-reported action — if the model claims FOLLOW_UP but its question
    // actually targets a different file/module, the focus has moved and the
    // counters must reset regardless of the label. On an unresolvable
    // identifier both counters are frozen (neither incremented nor reset): a
    // hallucinated focus is a data-quality event, not a genuine "still on
    // topic" turn. A moduleJumpRejected turn needs no special case here —
    // effectiveFocus already IS the kept (unchanged) focus in that case, so
    // the plain unchanged-vs-changed comparison below already produces the
    // right counter behaviour (module counter increments, file counter
    // resets only if a filePath was actually dropped).
    let turnsOnCurrentFocus: number;
    let turnsOnCurrentModule: number;
    if (pathRejected) {
      turnsOnCurrentFocus = state.turnsOnCurrentFocus;
      turnsOnCurrentModule = state.turnsOnCurrentModule;
    } else {
      const fileUnchanged = effectiveFocus.filePath === (state.currentFocus?.filePath ?? null);
      turnsOnCurrentFocus = fileUnchanged ? state.turnsOnCurrentFocus + 1 : 1;
      const moduleUnchanged = effectiveFocus.module === (state.currentFocus?.module ?? null);
      turnsOnCurrentModule = moduleUnchanged ? state.turnsOnCurrentModule + 1 : 1;
    }

    // Coverage tracking: only real CODE the candidate has actually been
    // shown (STAY at FILE granularity) plus the new resolved focus count as
    // visited. NARROW/FRONTIER are names-only menus in v2 (plan §5) — a
    // module/file NAME appearing as an option is not exposure, and marking
    // it visited merely for being offered would let a module get excluded
    // from FRONTIER before the interview ever actually engaged with it.
    // Grounding code doesn't count either — it's evaluation evidence, not
    // exploration.
    const newlySeenFiles = [
      ...followUpContext.stayCode.map((c) => c.filePath),
      ...(effectiveFocus.filePath ? [effectiveFocus.filePath] : []),
    ];
    const visitedFiles = Array.from(new Set([...state.visitedFiles, ...newlySeenFiles]));
    const visitedModules = Array.from(
      new Set([
        ...state.visitedModules,
        ...visitedFiles.map((f) => initialModuleFor(f)),
        ...(effectiveFocus.module ? [effectiveFocus.module] : []),
      ]),
    );

    // adaptive -> apply the model's suggestion; a fixed level is held
    // constant regardless of what the model proposes.
    const difficultyMode = state.difficultyMode;
    const difficulty = difficultyMode === "adaptive" ? decision.nextDifficulty : difficultyMode;

    const knownGaps = Array.from(
      new Set([...state.knownGaps, ...(decision.missingConcepts ?? [])]),
    ).slice(-INTERVIEW_STATE_LIMITS.maxKnownGaps);

    const newState: InterviewState = {
      ...state,
      currentTopic: decision.topic || state.currentTopic,
      topicsCovered: Array.from(new Set([...state.topicsCovered, state.currentTopic])).slice(
        -INTERVIEW_STATE_LIMITS.maxTopicsCovered,
      ),
      currentFocus: effectiveFocus,
      visitedFiles,
      visitedModules,
      turnsOnCurrentFocus,
      turnsOnCurrentModule,
      lastAction: decision.nextAction,
      difficulty,
      difficultyMode,
      knownGaps,
      questionCount: state.questionCount + 1,
    };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO chat_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
        [
          sessionId,
          decision.interviewerMessage,
          JSON.stringify({
            type: "question",
            topic: decision.topic,
            action: decision.nextAction,
            focus: effectiveFocus,
            focusRejected: pathRejected,
            moduleJumpRejected,
            evaluation: decision,
          }),
        ],
      );

      await client.query(
        `UPDATE chat_sessions SET state = $2, last_accessed_at = NOW() WHERE id = $1`,
        [sessionId, JSON.stringify(newState)],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    console.log(
      `[Interview] session=${sessionId} action=${decision.nextAction} ` +
        `focus=${effectiveFocus.filePath ?? "(none)"} module=${effectiveFocus.module ?? "(none)"} ` +
        `pathRejected=${pathRejected} moduleJumpRejected=${moduleJumpRejected} ` +
        `turnsOnFocus=${turnsOnCurrentFocus} turnsOnModule=${turnsOnCurrentModule} ` +
        `visitedModules=${visitedModules.length} difficulty=${difficulty}.`,
    );

    // `nextQuestion` is a legacy API field name kept for backwards
    // compatibility; it now holds the full next interviewer message (may
    // include a reaction, a woven-in correction, and/or a transition, not
    // just a bare question) — see `interviewerMessage` in
    // interviewEvaluationSchema for the source. `correction` is still
    // returned for structured/internal use, but the frontend no longer
    // displays it inline — its substance is already woven into the message.
    return { nextQuestion: decision.interviewerMessage, correction: decision.correction };
  }

  public async endInterview(sessionId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE chat_sessions SET status = 'completed', last_accessed_at = NOW() WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    await activityLogService.logEvent({
      userId,
      activityType: "INTERVIEW_COMPLETED",
      metadata: { sessionId }
    });
  }

  public async generateInsights(sessionId: string, userId: string): Promise<InterviewFinalAssessment> {
    const sessionRes = await pool.query(
      `SELECT state FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (sessionRes.rows.length === 0) throw new Error("Session not found");
    const state = withStateDefaults(sessionRes.rows[0].state);

    if (state.assessment) {
      return state.assessment;
    }

    const historyRes = await pool.query(
      `SELECT role, content, metadata FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );

    const messages = interviewPromptBuilder.buildFinalReviewPrompt(state, historyRes.rows);

    const assessment = await ollamaService.generateStructured<InterviewFinalAssessment>(
      messages,
      interviewFinalAssessmentSchema,
    );

    const newState = { ...state, assessment };
    await pool.query(
      `UPDATE chat_sessions SET state = $2, last_accessed_at = NOW() WHERE id = $1`,
      [sessionId, JSON.stringify(newState)]
    );

    return assessment;
  }
}

export const interviewService = new InterviewService();
