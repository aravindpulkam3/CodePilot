import type { ChunkMetadata } from "../../infrastructure/chunking/astChunking.service.js";
import type {
  RetrievedContext,
  CodeChunkSearchResult,
  DocChunkSearchResult,
} from "../../infrastructure/retrieval/retrievalTypes.js";
import type { ChangedCodeDeps } from "./changedCodeContext.js";

/** Index rows locate candidates only. Reparse source at HEAD; never reuse indexed line coordinates. */
export async function verifyReviewEvidence(
  context: RetrievedContext,
  headSha: string,
  deps: ChangedCodeDeps & {
    chunkDocument(path: string, source: string): Promise<ChunkMetadata[]>;
  },
): Promise<{
  context: RetrievedContext;
  excluded: Array<{ filename: string; reason: string }>;
}> {
  const codeChunks: CodeChunkSearchResult[] = [];
  const docChunks: DocChunkSearchResult[] = [];
  const excluded: Array<{ filename: string; reason: string }> = [];
  const paths = [
    ...new Set(
      [...context.codeChunks, ...context.docChunks].map(
        (chunk) => chunk.filePath,
      ),
    ),
  ];
  // Small bounded I/O batches, preserving retrieval order below.
  const refreshed = new Map<string, ChunkMetadata[]>();
  for (let offset = 0; offset < paths.length; offset += 4) {
    await Promise.all(
      paths.slice(offset, offset + 4).map(async (path) => {
        try {
          const source = await deps.fetchContent(path, headSha);
          if (source === null) {
            excluded.push({ filename: path, reason: "Not present at PR head" });
            return;
          }
          const isDoc = context.docChunks.some(
            (chunk) => chunk.filePath === path,
          );
          const chunks = isDoc
            ? await deps.chunkDocument(path, source)
            : await deps.chunkFile(path, source);
          refreshed.set(path, chunks);
        } catch {
          excluded.push({
            filename: path,
            reason: "PR-head source could not be fetched or parsed",
          });
        }
      }),
    );
  }
  for (const candidate of [...context.codeChunks, ...context.docChunks]) {
    const chunks = refreshed.get(candidate.filePath);
    if (!chunks) continue;
    const matches = chunks.filter(
      (chunk) =>
        chunk.symbol_name === candidate.symbolName ||
        chunk.qualified_name === candidate.symbolName,
    );
    if (!matches.length) {
      excluded.push({
        filename: candidate.filePath,
        reason: `Symbol unavailable at PR head: ${candidate.symbolName}`,
      });
      continue;
    }
    for (const chunk of matches) {
      const verified = {
        ...candidate,
        content: chunk.content,
        contentHash: chunk.content_hash,
        lineStart: chunk.start_line,
        lineEnd: chunk.end_line,
        commitSha: headSha,
      };
      if ("sectionPath" in candidate)
        docChunks.push(verified as DocChunkSearchResult);
      else codeChunks.push(verified);
    }
  }
  // A cached profile can contain live/mixed index facts. It is not PR-head evidence.
  return {
    context: { ...context, codeChunks, docChunks, repositoryProfile: null },
    excluded,
  };
}
