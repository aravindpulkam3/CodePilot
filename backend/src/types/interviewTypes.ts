// Repository-only. The 'general' mode skipped retrieval entirely, was never
// reachable from the UI (which hardcodes mode: "repository"), and doubled
// every prompt/retrieval path for a quiz-mode product surface that doesn't
// exist. See okay-so-the-thing-enumerated-crab.md for the removal rationale.
export interface InterviewConfig {
    mode: 'repository';
    repositoryId: string;
    domain?: 'dsa' | 'development' | 'core' | 'data' | 'ai';
    language?: string;
    technologies?: string[];
    difficulty: 'easy' | 'medium' | 'hard' | 'adaptive';
    focusTopics?: string[];
    questionCount?: number;
    followUpsEnabled: boolean;
}

/**
 * How many consecutive turns the interview may stay on one exact FILE
 * before it is nudged to leave that specific file (a sibling in the same
 * module, or back to MODULE scope) — NOT a forced NEW_TOPIC. See
 * MAX_TURNS_ON_MODULE for the bound that actually forces a topic change.
 * Shared between retreival.service.ts (sizes STAY vs NARROW) and
 * interviewPromptBuilder.ts (states the limit to the model) — one constant
 * so the two can't drift apart.
 */
export const MAX_TURNS_ON_FOCUS = 4;

/**
 * How many consecutive turns the interview may stay within one MODULE
 * (across any number of files/granularity changes within it) before it is
 * forced to NEW_TOPIC. This — not MAX_TURNS_ON_FOCUS — is the bound that
 * governs "the interview should eventually move on." Deliberately larger
 * than the file-level bound: drilling from auth.service.ts into jwt.ts into
 * token.middleware.ts is still one topic and shouldn't trip a full-topic
 * bound on every file change.
 */
export const MAX_TURNS_ON_MODULE = 8;

/**
 * The repository entity a question actually targets, at one of three
 * granularities — declared by the model via InterviewTurnEvaluation.nextFocus
 * and validated before being persisted here (see
 * InterviewService#resolveFocus). Never inferred from retrieval order: a
 * turn retrieves several files, and only the generator knows which one its
 * own question is about.
 *
 *   REPOSITORY: filePath = null, module = null   — "explain the system"
 *   MODULE:     filePath = null, module = "Auth" — "explain this area"
 *   FILE:       filePath = "auth/jwt.ts"         — "explain this implementation"
 *
 * Granularity is not a separate field — it's derived from which of
 * filePath/module is set, exactly mirroring how filePath itself is never
 * trusted raw but resolved against real repo data first.
 */
export interface InterviewFocus {
    /** Exact indexed path, or null unless granularity is FILE. */
    filePath: string | null;
    symbolName: string | null;
    /** A resolved module name (MODULE granularity), OR derived via
     * initialModuleFor(filePath) when granularity is FILE. Null at REPOSITORY. */
    module: string | null;
}

export type InterviewAction = 'FOLLOW_UP' | 'DEEP_DIVE' | 'SIMPLIFY' | 'NEW_TOPIC';

export interface InterviewState {
    /** Display label only (shown on the "Past Interviews" card) — NOT the repetition-prevention key. */
    currentTopic: string;
    /** Display history of topic labels. Not used for dedupe; see visitedFiles/visitedModules. */
    topicsCovered: string[];

    currentFocus: InterviewFocus;
    /** Stable-identifier coverage tracking — file paths shown as exploration surface (LOCAL/FRONTIER), not evaluation grounding. */
    visitedFiles: string[];
    visitedModules: string[];
    /** Consecutive turns on the exact current filePath; derived from focus identity, not from the model's self-reported action. See resolveFocus. */
    turnsOnCurrentFocus: number;
    /** Consecutive turns within the current module (across any file/granularity changes inside it). This is the bound that actually forces NEW_TOPIC — see MAX_TURNS_ON_MODULE. */
    turnsOnCurrentModule: number;

    /** The action that produced the question currently awaiting an answer — known state the NEXT retrieval routes on, at zero extra LLM cost. */
    lastAction: InterviewAction | 'INITIAL';

    /** Current effective difficulty (always a concrete level, even in adaptive mode). */
    difficulty: 'easy' | 'medium' | 'hard';
    /** Immutable copy of the user's original choice. Only when this is 'adaptive' does nextDifficulty ever get applied. */
    difficultyMode: 'easy' | 'medium' | 'hard' | 'adaptive';

    /** Deterministic aggregation of missingConcepts across turns — zero extra LLM calls, replaces re-reading the full transcript. */
    knownGaps: string[];

    questionCount: number;
    assessment?: InterviewFinalAssessment;
}

export interface InterviewFinalAssessment {
    overallAssessment: string;
    strengths: string[];
    weaknesses: string[];
    score: number;
}

/**
 * The model's raw, unvalidated focus declaration — see InterviewFocus for
 * the persisted/validated form. `filePath` and `module` are resolved in
 * that order (filePath first) by InterviewService#resolveFocus; neither is
 * trusted verbatim. Both null is a legitimate REPOSITORY-scope declaration,
 * not a rejection.
 */
export interface InterviewNextFocus {
    filePath: string | null;
    /** A module-level target with no single file chosen yet (MODULE granularity). Ignored if filePath is also present and resolves. */
    module: string | null;
    symbolName: string | null;
    reason: string;
}

export interface InterviewTurnEvaluation {
    score: number;
    answerQuality: 'poor' | 'weak' | 'adequate' | 'strong' | 'excellent';
    technicalAccuracy: number;
    depthOfUnderstanding: number;
    strengths: string[];
    weaknesses: string[];
    missingConcepts: string[];
    topic: string;
    nextAction: InterviewAction;
    nextDifficulty: 'easy' | 'medium' | 'hard';
    nextFocus: InterviewNextFocus;
    correction: {
        needed: boolean;
        explanation: string;
        keyPoints: string[];
    };
    /**
     * The interviewer's entire next spoken turn — not just a bare question.
     * May open with a reaction to what the candidate said (or may not) and
     * weave a correction in conversationally, flowing into the next question
     * as one continuous thought. Declared last so the model has already
     * committed to the evaluation, nextAction/nextFocus, and correction by
     * the time it composes this. See interviewPromptBuilder.ts's "How to
     * respond" section for the full behavioral contract.
     */
    interviewerMessage: string;
}
