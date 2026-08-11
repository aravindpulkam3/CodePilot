import { Pool } from "pg";
import { PgSummaryStore } from "../utils/pgSummaryStore.js";
import { embedder } from "./embedding.service.js";
import type { EmbeddingClient, RepoFile } from "../types/summaryTypes.js";
import { llmService, LLMService } from "./llm.service.js";
import { runSummarizationPipeline } from "./summaryPipeline.service.js";

// `embedder` is a class instance that `implements EmbeddingClient` directly
// now — this line still type-checks it at the boundary, same reasoning as
// before, just with no separate wrapper object to keep in sync.
const embeddings: EmbeddingClient = embedder;

// Bring your own LLM client — example using the Anthropic SDK.
// (Any model that reliably returns JSON on request works here.)
// `anthropic` below is a placeholder: import and construct your actual
// `new Anthropic({ apiKey: ... })` client and use it here.
const llm: LLMService = llmService;

export async function runForRepository(repositoryId: string, files: RepoFile[], readme: string | null, pkg: Record<string, unknown> | null) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PgSummaryStore(pool);

  const result = await runSummarizationPipeline(
    { repositoryId, files, readme, packageMetadata: pkg },
    {
      llm,
      embeddings,
      store,
      useLLMModuleRefinement: false, // flip on if heuristic module clustering looks off for this 
    },
  );

  console.log(
    `[Summarization] ${result.fileSummaries.length} files, ` +
      `${result.componentSummaries.length} components, ` +
      `1 architecture summary, 1 repository summary — stored in repository_summaries.`,
  );

  return result;
}