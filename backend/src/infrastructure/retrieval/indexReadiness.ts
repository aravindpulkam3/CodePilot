export type IndexReadiness = "ready" | "failed" | "wait" | "timed-out";

/** A SHA alone is unsafe: delta jobs retain it while mutating live rows. */
export function decideIndexReadiness(
  state: { lastIndexedSha: string | null | undefined; status: string | null | undefined },
  deadlinePassed: boolean,
): IndexReadiness {
  if (state.status === "READY" && state.lastIndexedSha) return "ready";
  if (state.status === "FAILED") return "failed";
  return deadlinePassed ? "timed-out" : "wait";
}
