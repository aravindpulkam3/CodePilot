import { observe, type DiagnosticObserver } from "../../shared/utils/diagnostics.js";

export const GENERATION_RETRY = { maxAttempts: 5, delaysMs: [1000, 2000, 4000, 8000] } as const;

/** Restart only before any text is exposed; replaying a partial stream would duplicate an answer. */
export async function* retryGenerationStream(
  request: () => AsyncIterable<{ text: string }>,
  onDiagnostic?: DiagnosticObserver,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): AsyncGenerator<{ text: string }, void, unknown> {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    let emittedText = false;
    try {
      for await (const chunk of request()) {
        if (chunk.text) emittedText = true;
        yield chunk;
      }
      observe(onDiagnostic, "generationAttempt", {
        attempt, maxAttempts: GENERATION_RETRY.maxAttempts, status: "succeeded",
        elapsedMs: performance.now() - started, delayMs: 0,
      });
      return;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
      const retry = !emittedText && status !== null && [500, 502, 503, 504].includes(status) && attempt < GENERATION_RETRY.maxAttempts;
      const delayMs = retry ? GENERATION_RETRY.delaysMs[attempt - 1] : 0;
      observe(onDiagnostic, "generationAttempt", {
        attempt, maxAttempts: GENERATION_RETRY.maxAttempts, status: "failed", emittedText,
        httpStatus: status, elapsedMs: performance.now() - started, delayMs,
      });
      if (!retry) throw error;
      console.warn(`[LLM] HTTP ${status}; retrying stream (${attempt + 1}/${GENERATION_RETRY.maxAttempts}) in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}

/** Retry only rejected transient server requests, never parsed/validated outputs. */
export async function retryGeneration<T>(
  request: () => Promise<T>,
  onDiagnostic?: DiagnosticObserver,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    try {
      const result = await request();
      observe(onDiagnostic, "generationAttempt", {
        attempt, maxAttempts: GENERATION_RETRY.maxAttempts, status: "succeeded",
        elapsedMs: performance.now() - started, delayMs: 0,
      });
      return result;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number(error.status) : null;
      const retry = status !== null && [500, 502, 503, 504].includes(status) && attempt < GENERATION_RETRY.maxAttempts;
      const delayMs = retry ? GENERATION_RETRY.delaysMs[attempt - 1] : 0;
      observe(onDiagnostic, "generationAttempt", {
        attempt, maxAttempts: GENERATION_RETRY.maxAttempts, status: "failed",
        httpStatus: status, elapsedMs: performance.now() - started, delayMs,
      });
      if (!retry) throw error;
      console.warn(`[LLM] HTTP ${status}; retrying generation (${attempt + 1}/${GENERATION_RETRY.maxAttempts}) in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}
