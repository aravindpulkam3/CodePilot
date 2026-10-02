export type IndexReadiness = "ready" | "failed" | "wait" | "timed-out";

/**
 * Decides whether a repository's index may be served right now.
 *
 * `last_indexed_sha` is the whole safety state: indexing sets it only once a
 * complete index exists and clears it (NULL) whenever rows may be partial or
 * mixed — a run that failed after enqueuing chunks, or an untrustworthy delta.
 * So a non-null SHA is servable whatever the status says (a run that failed
 * before enqueuing leaves the previous index intact), and a NULL one never is,
 * however long the caller has waited.
 */
export function decideIndexReadiness(
  state: { lastIndexedSha: string | null | undefined; status: string | null | undefined },
  deadlinePassed: boolean,
): IndexReadiness {
  if (state.lastIndexedSha) return "ready";
  if (state.status === "FAILED") return "failed";
  return deadlinePassed ? "timed-out" : "wait";
}
