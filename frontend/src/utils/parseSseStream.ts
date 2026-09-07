// Shared SSE-frame reader with cross-read buffering. Every existing call
// site (useUnifiedChat.ts, PullRequestDetails.tsx's old Review Q&A tab)
// decoded each `reader.read()` chunk and split on "\n\n" independently,
// with no carry-over — a `data: {...}\n\n` frame split across two network
// reads silently lost its second half. This buffers the trailing
// (possibly incomplete) fragment across reads so no frame is ever dropped.
export async function readSseStream(
  response: Response,
  onPayload: (payload: any) => void
): Promise<void> {
  if (!response.body) throw new Error("No response stream body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    // The last element may be an incomplete frame — keep it for next read.
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const jsonStr = line.slice("data: ".length);
      try {
        onPayload(JSON.parse(jsonStr));
      } catch {
        // Ignore malformed frames rather than crashing the stream.
      }
    }
  }

  // Flush any trailing complete frame left in the buffer after the stream
  // closes (a final frame with no trailing "\n\n" separator).
  if (buffer.trim()) {
    const line = buffer.split("\n").find((l) => l.startsWith("data: "));
    if (line) {
      try {
        onPayload(JSON.parse(line.slice("data: ".length)));
      } catch {
        // ignore
      }
    }
  }
}
