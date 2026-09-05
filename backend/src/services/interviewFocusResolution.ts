import { InterviewFocus, InterviewAction } from "../types/interviewTypes.js";
import { InterviewGranularity } from "../types/retrievalTypes.js";

/**
 * Granularity is never a separately-declared/validated field — it's always
 * derived from which of filePath/module is set on a (already-resolved)
 * InterviewFocus, exactly mirroring how the raw model output itself is never
 * trusted and is resolved against real repo data first. Shared by retrieval
 * (routes STAY/NARROW/GROUNDING) and the prompt builder (states the current
 * scope to the model) so the two can't drift on what "current granularity"
 * means.
 */
export function granularityOf(focus: InterviewFocus): InterviewGranularity {
  if (focus.filePath) return "FILE";
  if (focus.module) return "MODULE";
  return "REPOSITORY";
}

/**
 * Pure form of the filePath resolution ladder (see
 * InterviewService#resolveFocus for the DB-backed wrapper that supplies
 * contextPaths/indexedPaths). Never trusts the raw string — resolves it
 * against real data or rejects it outright. Ladder: exact match in this
 * turn's shown context -> exact match in the full indexed file list ->
 * unique basename match -> reject.
 *
 * `rawPath` absent/empty is NOT a rejection — it's a legitimate "no file
 * target" declaration, signalled by `resolvedPath: null, rejected: false`.
 *
 * Deliberately kept dependency-free (no DB, no other services) so it's
 * unit-testable in isolation — see interviewFocusResolution.test.ts.
 */
export function resolvePathAgainstList(
  rawPath: string | null | undefined,
  contextPaths: string[],
  indexedPaths: string[],
): { resolvedPath: string | null; rejected: boolean } {
  const raw = rawPath?.trim();
  if (!raw) return { resolvedPath: null, rejected: false };

  if (contextPaths.includes(raw)) return { resolvedPath: raw, rejected: false };
  if (indexedPaths.includes(raw)) return { resolvedPath: raw, rejected: false };

  const base = raw.split("/").pop();
  const matches = indexedPaths.filter((p) => p.split("/").pop() === base);
  if (matches.length === 1) return { resolvedPath: matches[0], rejected: false };

  return { resolvedPath: null, rejected: true };
}

/**
 * Pure form of the module resolution ladder (plan §2). Same
 * reject-rather-than-guess philosophy as resolvePathAgainstList, with one
 * deliberate loosening: module labels are short English phrases ("Auth",
 * "Utilities"), so a case/whitespace slip is a plausible, cheap-to-forgive
 * mistake rather than a hallucination — unlike a file path, which must
 * match verbatim. Ladder: exact match in this turn's shown module context
 * -> exact match in the full module inventory -> case-insensitive/trimmed
 * match -> reject.
 */
export function resolveModuleAgainstList(
  rawModule: string | null | undefined,
  contextModules: string[],
  allModules: string[],
): { resolvedModule: string | null; rejected: boolean } {
  const raw = rawModule?.trim();
  if (!raw) return { resolvedModule: null, rejected: false };

  if (contextModules.includes(raw)) return { resolvedModule: raw, rejected: false };
  if (allModules.includes(raw)) return { resolvedModule: raw, rejected: false };

  const lower = raw.toLowerCase();
  const caseInsensitiveMatch = allModules.find((m) => m.toLowerCase() === lower);
  if (caseInsensitiveMatch) return { resolvedModule: caseInsensitiveMatch, rejected: false };

  return { resolvedModule: null, rejected: true };
}

/**
 * Deterministic action/focus consistency check (plan §2b) — the one new
 * rule beyond "does this resolve to something real": a stay-action
 * (FOLLOW_UP/DEEP_DIVE/SIMPLIFY) may narrow or de-escalate within the
 * current module, but may not jump the persisted module sideways to a
 * different, unrelated one. Only NEW_TOPIC may do that.
 *
 * This corrects only what gets PERSISTED as state.currentFocus — it never
 * touches interviewerMessage or the evaluation fields the model produced, and it
 * never re-runs the LLM call. `resolvedFocus.module` is always consistent
 * with `resolvedFocus.filePath` by construction (module is derived from
 * filePath at FILE granularity), so a rejected jump always means the whole
 * resolvedFocus — filePath included — falls outside the kept module and
 * must be dropped, not selectively kept.
 */
export function checkActionFocusConsistency(
  action: InterviewAction,
  resolvedFocus: InterviewFocus,
  previousFocus: InterviewFocus,
): { focus: InterviewFocus; moduleJumpRejected: boolean } {
  if (action === "NEW_TOPIC") {
    return { focus: resolvedFocus, moduleJumpRejected: false };
  }

  const prevModule = previousFocus.module;
  const nextModule = resolvedFocus.module;

  if (prevModule && nextModule && nextModule !== prevModule) {
    console.warn(
      `[Interview] moduleJumpRejected: action=${action} tried to move from module ` +
        `"${prevModule}" to "${nextModule}". Keeping previous module.`,
    );
    return {
      focus: { filePath: null, symbolName: null, module: prevModule },
      moduleJumpRejected: true,
    };
  }

  return { focus: resolvedFocus, moduleJumpRejected: false };
}
