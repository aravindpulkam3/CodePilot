/** Opt-in observations are isolated from the objects and control flow they observe. */
export interface DiagnosticEvent {
  stage: string;
  data: any;
}
export type DiagnosticObserver = (event: DiagnosticEvent) => void;

export function observe(
  observer: DiagnosticObserver | undefined,
  stage: string,
  data: unknown,
) {
  if (!observer) return;
  try {
    observer({ stage, data: structuredClone(data) });
  } catch {
    console.warn("[Diagnostics] Observer failed; operation continues.");
  }
}
