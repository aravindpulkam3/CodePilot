# CodePilot Agent Guide

## Project Overview

CodePilot indexes GitHub repositories for codebase Q&A, PR reviews/finding discussions, and repository-specific interviews. This guide describes current implementation. Source takes precedence over README.md and local, gitignored CLAUDE.md. Backend paths below are relative to `backend/src/` unless qualified; frontend paths are relative to `frontend/src/` in its section.

## Tech Stack and Processes

- Two independent npm packages, `backend/package.json` and `frontend/package.json`; no root package/workspace runner.
- Backend: TypeScript, Node ESM, Express 4, raw PostgreSQL queries through `pg`, pgvector, Clerk, GitHub REST, BullMQ, ioredis, Svix, web-tree-sitter WASM.
- Frontend: React 18, Vite 5, React Router 6, TanStack Query 5, Clerk React, Axios, Tailwind 3, Lucide, Sonner, Prism.
- AI: hardcoded Gemini generation (`gemini-3.6-flash`), embeddings (`gemini-embedding-001`), local Ollama (`qwen2.5-coder:7b`).
- Separate processes: frontend, API (`backend/src/server.ts`), workers (`backend/src/worker.ts`). API does not consume indexing jobs.
- `backend/docker-compose.yml`: PostgreSQL 17/pgvector and two Redis instances; no application/Ollama containers.

## Repository Map

| Path | Responsibility |
| --- | --- |
| `backend/src/app.ts` | Express middleware order and route mounts |
| `backend/src/config/` | Environment, shared DB pool, Redis connections, queues, Bull Board |
| `backend/src/features/repository/` | Repository rows, GitHub controllers, sync/index/summarize orchestration, import graph |
| `backend/src/features/review/` | Review generation/persistence and structured review prompt |
| `backend/src/features/chat/` | Unified sessions/messages/SSE, repository/review/finding context providers |
| `backend/src/features/interview/` | Interview state machine, prompt/schema, focus validation |
| `backend/src/features/user/`, `backend/src/features/webhook/` | User mapping and Clerk webhook; unmounted GitHub webhook stub |
| `backend/src/features/dashboard/` | Recent work, pending PRs, activity logs |
| `backend/src/infrastructure/` | `github`, `chunking`, `embedding`, `llm`, `summarization`, `retrieval` implementations |
| `backend/src/shared/` | SQL buffers, cache/queue helpers, import resolution, query utilities, shared citation rendering, Express types |
| `backend/src/db/schema.sql` | Executable schema, additive changes and status backfills |
| `backend/parsers/`, `backend/scripts/` | Committed WASM grammars and sync/verification scripts |
| `frontend/src/pages/`, `frontend/src/routes/index.tsx` | Pages and nested route tree |
| `frontend/src/services/api/`, `frontend/src/hooks/` | HTTP functions, server-state queries/mutations and streaming state |
| `frontend/src/components/` | Layout, repository workspace, review/diff, chat and reusable UI |
| `frontend/src/types/`, `frontend/src/utils/` | API/UI types, diff parsing, SSE reader, syntax highlighting, class-name helper |

## Backend and Request Flow

Usual flow: `server.ts -> app.ts -> feature router -> controller -> service -> pg / GitHub / LLM / queues`. Dashboard/status controllers also contain SQL; no universal data-access layer.

`app.ts` installs CORS, raw-body webhooks **before** JSON parsing, Clerk, feature routers, then error handler. API families: `/api/users`, `/api/github`, `/api/repositories`, `/api/reviews`, `/api/chat`, `/api/interview`, `/api/dashboard`. `/api/health` is static liveness, not dependency readiness. `/admin/queues` exposes Bull Board to every authenticated user without an admin-role check.

Listing/import saves metadata. Start Working records membership and enqueues sync; new AI sessions can request JIT sync. Phase 1 produces searchable chunks/imports; Phase 2 produces summaries/READY. Chat streams, PR generation and interview turns execute in the API process, not BullMQ.

## Authentication and GitHub Integration

- `middleware/auth.middleware.ts` maps `getAuth(req)` through `app_users.clerk_id`, self-healing a missing row via `userService.syncFromClerkApi()`. It attaches `req.dbUser = { id, clerkId }` (`shared/types/express.d.ts`). Internal UUID `id` is for ownership/FKs/cache keys; `clerkId` is for Clerk/OAuth. Numeric `github_repo_id` is not the repository UUID.
- `/users/me` performs its own Clerk check and profile self-healing. The live Clerk webhook route verifies Svix signatures and handles user create/update/delete. Keep its raw body intact.
- `infrastructure/github/github.service.ts` gets OAuth tokens from Clerk on demand, not application DB storage. Connected sync/summarization can fall back to anonymous access after token failures. Public imports use anonymous access; PR endpoints still require a GitHub token.
- **Authorization is incomplete.** Start/stop-work and existing chat session/message access check ownership. Repository details/status, PR/review operations, and supplied IDs during session/interview creation do not consistently check it. `findRepositoryById()` is unscoped; authentication alone does not ensure tenant isolation.
- GitHub push handler (`features/webhook/webhook.controller.ts`) is an unmounted identity-mapping stub. No automatic push sync or posting reviews to GitHub.

## Database

`config/db.ts` exports one Pool. `db/migrate.ts` executes `db/schema.sql`; no migration tracking/ORM. `db/migrations/001_init.sql` is only a comment.

| Table | Role and relationships |
| --- | --- |
| `app_users` | UUID primary key, unique external `clerk_id`, profile/GitHub connection metadata |
| `repositories` | UUID, owner `user_id -> app_users`, unique `(user_id, github_repo_id)`, `connected`/`public_import`, branch/SHA/status/progress/workspace fields |
| `repository_embeddings` | Code and documentation chunks; repo FK, commit SHA, path/symbol/line metadata, enriched content/hash, `VECTOR(3072)`; unique `(repository_id, file_path, content_hash)` |
| `repository_summaries` | JSONB and optional `VECTOR(3072)` for file/component/architecture/repository nodes; unique `(repository_id, node_type, node_key)`; `parent_key` encodes hierarchy. **No repository FK/cascade is declared here.** |
| `repository_relationships` | Repo FK; file-key graph edges, metadata, composite uniqueness. Schema allows `IMPORTS` and `RELATED_COMPONENT`; current writer emits only `IMPORTS`. |
| `reviews`, `review_findings`, `review_messages` | Reviews reference repository and PR number/head SHA; findings and original prompt/AI response reference review UUID. `is_latest` index is not unique. |
| `chat_sessions`, `chat_messages` | Sessions owned by user, optional repository/review/finding FKs, type/status/JSONB state; messages hold content and metadata including sources/evaluations |
| `interview_sessions` | Legacy table still created by schema; active interview service does not use it |
| `activity_logs` | User activity with JSONB metadata; repository deletion sets its repository FK null |

Most ownership FKs cascade. A partial unique index allows one `ISSUE_CHAT` per `(finding_id, user_id)`; select-then-insert can still race. Summary/graph keys are paths/module names, not UUID FKs. No persisted full AST/symbol table or source snapshot exists.

Schema changes use additive `IF NOT EXISTS`; changing CREATE alone does not update existing tables. Backfills rerun with migration. The default remains `unindexed`; runtime/UI also use `NOT_STARTED`, `SYNCING`, `INDEXING`, `SEARCHABLE`, `SUMMARIZING`, `READY`, `FAILED`.

## Repository Indexing Pipeline

Start with `features/repository/repositorySync.service.ts`:

- `enqueueSync()` deduplicates `sync-${repositoryId}`. SYNCING/INDEXING skips sync; SUMMARIZING does not.
- Equal default-branch tip and `last_indexed_sha` returns immediately. Initial indexing uses GitHub recursive tree REST; delta compares old/new SHA and fetches changed contents pinned to new SHA. No local clone.
- Initial fetch skips `package-lock.json` and root `dist/`, downloading other blobs before parser filtering. Delta has no equivalent filter. No pagination/truncated-tree recovery.
- Jobs contain 50 files; repository rows track counts. Zero-file delta advances Phase 1 and queues summaries if needed, without assuming convergence.

`features/repository/repositoryIndex.service.ts` executes each chunk:

1. Snapshot `last_indexed_sha`; collect existing indexed paths plus this job's paths for import resolution.
2. Outside a DB transaction, produce AST/doc chunks, compare enriched-content SHA-256 hashes, embed only new hashes, buffer removals/retained hashes and import-edge changes.
3. In a short transaction, recheck snapshot SHA, delete stale chunks, insert embeddings/metadata, restamp retained hashes for touched files, replace outgoing imports, and increment persisted completion counters.
4. When completed count reaches total, set `last_indexed_sha`, `searchable_at`, `SEARCHABLE`; after commit enqueue summaries and emit cache invalidation. Payload `isFinalChunk` is logging-only; completion order is not enqueue order.

Removal deletes chunks and incoming/outgoing edges; Phase 2 separately deletes file summaries. **Ingestion `FileChange` loses rename old paths**; falsy content is skipped. Renames/emptied files can retain old rows.

Atomicity is **per chunk**. Later syncs retain `searchable_at`; retrieval does not filter by `commit_sha`, untouched files keep prior SHAs, and readers can see partial updates. This is not a revision-isolated repository snapshot.

## AST and Chunking

`infrastructure/chunking/astChunking.service.ts` owns the language registry and both independent representations:

- `chunkFile()` returns retrieval material. Registered extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.cpp` (not every extension in those language families). Grammars are loaded from `process.cwd()/parsers`; run backend commands from `backend/`.
- Captures include functions/classes/methods, TS interfaces/enums/type aliases and assigned arrow/function expressions. Small outer symbols suppress duplicate nested chunks. Above 6,000 **non-whitespace characters**, classes become skeleton + members where possible; other symbols split at AST statement boundaries. Indivisible statements stay whole, so this is not a strict token cap.
- Hashes cover enriched headers + source. `qualified_name` stays stable across parts; `symbol_name`, `chunk_index`, `chunk_total` distinguish them. Lines are 1-based.
- Parsed nonempty files without chunks get a whole-file fallback. Unsupported files/grammar failures can return `[]`, deleting prior chunks. Use `backend/scripts/syncParsers.mjs` and verification, not legacy `backend/setup-parsers.js`; compatible grammars use `dylink.0` from `@vscode/tree-sitter-wasm`.
- `extractFileAstMetadata()` independently extracts imports/exports/classes/interfaces/functions/methods/decorators/limited inheritance and full-source hash. **Never derive this transient inventory from retrieval chunks**: small-class methods and skeletonized classes must remain represented for summaries.

`shared/utils/importResolver.ts` resolves relative paths only; no aliases or `.js`-to-`.ts` remapping, useful Python/Go edges, or reconciliation of incomplete cross-chunk `knownPaths`. Missing graph edges do not prove independence.

`shared/utils/documentationPaths.ts` accepts only root README variants (bare/md/markdown/rst/txt, case-insensitive). Documentation chunking preserves Markdown headings/breadcrumbs/fences/tables, targets 200 lines/6,000 chars with 10-line block overlap and 40-chunk maximum. These are `symbol_type='documentation'` embeddings, not AST file summaries.

## Summarization Pipeline

`features/repository/repositorySummarize.service.ts` is Phase 2; `infrastructure/summarization/summaryPipeline.service.ts` implements the hierarchy. Full and incremental runs receive **Ollama** and the embedding client through dependency injection.

- Skip stale/already-summarized targets. Fetch canonical README at target SHA via `/readme`: 404 means absent; other failures throw. Retrieval never fetches live README.
- First run fetches source again; incremental run diffs **last_summarized_sha**, which may lag across several Phase 1 revisions. `packageMetadata` is currently passed as null.
- Summaries: full source + AST -> file -> component -> architecture -> repository with README. Full-file/higher-level prompts lack complete size caps.
- Full module discovery adds import-density merging to path heuristics; optional LLM refinement is disabled. Incremental assignment/interview inventory use only `initialModuleFor()`. Use POSIX repository paths even on Windows.
- Merkle-style hashes skip regeneration: source -> sorted component child hashes -> architecture -> repository including README/package metadata. Prompt/model versions are not hash inputs; changing prompts alone does not regenerate summaries.
- `MemorySummaryStore` overlays DB reads and buffers writes. Commit under a repository `FOR UPDATE` lock only if `last_indexed_sha` still equals target; write summaries plus `last_summarized_sha`/`READY` together. Failures record `last_summary_error` and conditionally restore `SEARCHABLE`; code remains usable.
- After settlement, `reconverge()` queues outstanding SHA. Incremental runs do not delete empty components and can disagree with full-run module assignments.

## Embeddings and Retrieval

`infrastructure/embedding/embedding.service.ts` uses `RETRIEVAL_DOCUMENT` for enriched chunks/summary prose, `RETRIEVAL_QUERY` for questions. `shared/utils/embedUtil.ts` selects semantic summary fields rather than raw JSON. Both vector columns are 3,072-dimensional: coordinate model/schema/data changes. Batch embedding can silently omit missing vectors.

The orchestrator filename is misspelled: **`infrastructure/retrieval/retreival.service.ts`**. Semantic SQL uses cosine similarity (`1 - (embedding <=> query)`), default 0.6 threshold. No ANN index, BM25, LLM reranker or agentic loop is configured. Code search excludes docs. Structural search balances files with `ROW_NUMBER()` and threshold 0; generic search's `||` fallback makes zero ineffective.

`ensureSearchable()` enqueues JIT sync and polls job/repository within 60s at 2s intervals. Continuations use read-only `assertSearchable()`. Both accept existing `searchable_at` **before** checking FAILED, without guaranteeing freshness; otherwise throw `INDEXING_IN_PROGRESS`/`INDEXING_FAILED`.

Use `listSummariesByType()` for singleton/unranked summaries; never invent a placeholder vector. Review/interview attach high-level summaries only when `READY`. **Q&A's `searchSummaries()` path has no equivalent readiness check** and can combine older summaries with newer code.

## PR Review Pipeline

`POST /api/reviews -> review.controller.ts -> review.service.ts -> GitHub PR/details/files -> retrieveReviewContext -> codeReviewPromptBuilder.ts -> Gemini -> SQL transaction`.

- Always creates a review: no generation cache/queue/lock/SHA deduplication. Retrieval gets all changed/renamed paths before prompt ignore filtering.
- Retrieval is **file/graph driven**: changed-file code, direct test/non-test dependents, dependencies, semantic code excluding changed files. No changed-symbol/exact-definition or sibling-test lookup; tests use imports + `isTestFile()`.
- Expand 20 changed paths; suppress caller fan-in >30. Chunks/file 3; totals changed/tests/dependents/dependencies/semantic: 40/12/20/20/25. Structural threshold 0 versus semantic 0.6.
- Candidate merging uses `filePath#lineStart-lineEnd`; reranking uses strongest `(weight * similarity)` + 0.25 of other strengths. See `retrievalTypes.ts` for weights; ties use similarity/path/line.
- `contextBudget.service.ts` estimates tokens as characters/4, defaults to 15,000 tokens of retrieved code; changed code first, then remaining graph/test/semantic quotas 35%/20%/45% with overflow redistribution. Retrieval trace records timing, counts, budget and dropped candidates.
- Docs use cleaned title/description, basename fallback, or null to skip search. Prompt combines default-branch provenance, optional overview, code/docs/diff. Context is not PR-head/merge-base code; its SHA label comes from a pre-JIT-sync row and can lag.
- Prompt ignores lockfiles, root dist/build/coverage, minified assets and listed binary/media extensions. Patch budget is 80,000 characters and documentation 6,000 characters, separately from retrieval budget. No unified total context cap.
- Structured result: summary, overall score, risk, findings with severity/category/path/line/title/description/recommendation/optional suggestion. Transaction demotes prior `is_latest`, inserts review/findings, and saves original prompt plus JSON result in `review_messages`.
- GET returns `{latest,history}` with finding IDs; POST findings lack IDs, requiring frontend refetch. UI marks outdated by comparing review/PR head SHAs.
- `REVIEW_CHAT`/`ISSUE_CHAT` load stored review/findings, without new repository retrieval or original diff. ISSUE_CHAT means review finding, not GitHub Issues. All unified chat streams use Ollama.

## Repository Q&A Pipeline

`RepositoryChat.tsx -> chat stream route -> chatService -> RepositoryContextProvider -> retrieveQAContext -> Ollama stream -> chat_messages`.

- Sessions normalize `QA -> REPO_QA`, `REVIEW -> REVIEW_CHAT`. New sessions generally get new rows; only finding sessions are reused by backend identity.
- Persist user message first; last 10 messages become history. `conversationalQuery.ts` blends up to 300 chars of the prior **user** turn only for anaphoric questions <=10 words, never assistant content.
- Up to 10 summary hits -> 3 components/5 files by authoritative `node_key` -> 10 scoped code chunks. Missing scope/results falls back repo-wide. Independently search up to 3 README sections.
- A top code match >=0.75 adds up to 12 dependencies and 12 dependents of one anchor as path-only evidence. This is not PR review's multi-category code expansion.
- Provider budgets by evidence score and code strength: full/reduced code 6,000/2,500 chars, docs 3,000/1,200, overview/architecture 1,200/500 each, components 1,500/600. This is separate from review's token allocator.
- Keep `[Source N]` code and `[Doc N]` docs distinct: code governs behavior, docs stated intent. Sources include kind/path/lines/content/similarity, persist in assistant `metadata.sources`, and are exposed by `getMessages()`. Badges can include items omitted by prompt caps.
- SSE payloads are `{type,data}` with `sessionId`, `sources`, `metadata`, `text`, and controller `error`; completion closes the stream. Failed generation can leave the user message without an assistant response.

## Interview Pipeline

`InterviewPage.tsx -> /api/interview/start|:sessionId/answer|end|insights -> interview.service.ts`. These are ordinary JSON requests. Only repository mode is implemented; extra config fields do not establish a general-interview flow.

- Active state lives in `chat_sessions.state`, transcript/evaluation in `chat_messages.metadata`. Starting retrieves context and generates the first question before transactionally creating session + assistant message.
- Start context contains indexed module inventory ranked by import fan-in, relevant docs, and READY-gated overview/architecture; no initial code chunks. Follow-up retrieval embeds the **last interviewer question**, never the candidate's answer.
- REPOSITORY/MODULE/FILE focus controls grounding, stay, narrow and frontier context. Raw code appears only at FILE depth from focus/one-hop neighbors. Coverage uses indexed paths + `initialModuleFor()`, independent of summaries.
- One Gemini structured call per turn combines evaluation and next spoken `interviewerMessage`: 0-10 score/accuracy/depth, quality label, strengths/gaps, correction, action, difficulty and next focus. Actions are `FOLLOW_UP`, `DEEP_DIVE`, `SIMPLIFY`, `NEW_TOPIC`.
- `interviewFocusResolution.ts` validates paths/modules, resolves unique basenames and rejects cross-module stay actions. Symbols are checked against chunks; never trust model paths verbatim.
- State tracks focus/visits/counters, gaps (8), topics (20), difficulty and question count. Only adaptive mode changes difficulty. Follow-ups use last 12 messages + current answer. Four file-focus/eight module turns guide prompts; NEW_TOPIC at module limit is not server-forced.
- End marks complete. Insights uses Ollama/full transcript, then reuses `state.assessment`; concurrent API calls are not serialized. No enforced maximum length, per-turn SHA, or complete answer/insights status/type guard exists.

## BullMQ, Redis and Caching

| Infrastructure | Current behavior |
| --- | --- |
| Cache Redis | Port 6379; 256 MB allkeys-lru, no persistence; bounded request retries |
| Queue/coordination Redis | Host port 6380; noeviction, AOF volume; BullMQ connections use `maxRetriesPerRequest: null`; separate worker connections |
| `RepositorySync` | Concurrency 2, deterministic per-repo job ID |
| `RepositoryIndex` | Concurrency 4, 50-file payloads containing raw content, auto job IDs |
| `RepositorySummarize` | Concurrency 1 per worker process, deterministic per-repo ID, target SHA and convergence recheck |

Queues: 3 attempts, exponential backoff from 5s, retain 100 completed/500 failed. Workers skip jobs older than 1h. `shared/utils/queueHelpers.ts` removes terminal deterministic-ID jobs before re-adding. It is not a global lock; `cache.ts`'s `withLock()` is unused. Preserve sequential summaries, noting other workers/API Ollama calls can overlap.

Important cache namespaces/TTL seconds:

| Keys | TTL |
| --- | --- |
| `github:sync:<internal-user-id>` metadata sync throttle | 60 |
| `github:repo:<owner>:<name>:latestCommit` and `:etag` | 60, conditional GitHub request rather than a simple cache-only return |
| GitHub `file:<sha>:<path>` / `readme:<sha>` | 900 |
| `repo:<id>:pulls`, `repo:<id>:pr:<n>:details` | 90 |
| `repo:<id>:pr:<n>:reviews` | 300 |
| `repo:<id>:pr:<n>:review:<head-sha>:findings` | 3,600 |
| `repo:<id>:indexed-paths`, `:import-fan-in`, `:summary:<type>:<limit>` | 600 |
| `embed:query:<model>:<sha256-of-query>` | 3,600 |
| `user:<internal-id>:dashboard:<section>` | 300 |

`withCache()` serializes JSON, falls back on cache errors and skips null/undefined. Direct ETag cache access can instead block sync on failure. General vector results/answers are uncached.

`shared/events/eventEmitter.ts` uses in-process async listeners + Redis SCAN deletion, not durable pub/sub or awaited delivery. Phase 1 invalidates paths/fan-in/details/dashboard, Phase 2 summary lists, review completion reviews/dashboard. Same-head findings are keyed by SHA, not review UUID, and escape review-list invalidation. Start/stop-work and several activity/session mutations omit server invalidation.

Coordination Redis rate limits per internal user: sync 5/600s, chat 20/300s, review 10/3600s, blocks 60s. Public import uses sync; session create/explicit streams and interview start/answer use chat. `/chat/stream`, start-working and insights bypass these limits. Limiter Redis errors also become 429.

## Frontend Architecture

- `main.tsx` installs BrowserRouter/Clerk/QueryProvider/Sonner; App renders routes. `ProtectedRoute` waits for Clerk **and** `useApiClient()` before children fetch. Login/signup wildcards support Clerk substeps.
- Shared Axios `services/api/clientApi.ts` gets fresh Clerk tokens through an idempotent interceptor; errors toast globally. Fetch/SSE must handle auth and errors separately.
- TanStack Query: 30s stale time, one retry, no window-focus refetch. React state handles streaming/selection; ThemeContext persists theme. No Redux/generated API contract.
- `/repositories/:repositoryId` nests overview/pulls/PR/chat/interview under `RepositoryLayout.tsx`; add repo pages here. Q&A/interview session IDs are URL params. Header/subnav serves overview/list, compact bar serves chats, PR owns its chrome.
- `PullRequestDetails.tsx`: PullRequestBar, ChangedFilesRail, Prism DiffViewer, ReviewAIPanel. Findings anchor to new-side lines with unanchored fallback. `useReviewAiPanel()` manages review/finding chat; scope is local state, not CLAUDE.md's older query-param design.
- `RepositoryChat.tsx` uses ChatInterface, history/session hooks and source previews. It still parses SSE independently without buffering incomplete network frames; `utils/parseSseStream.ts` is the buffered reader used by review/finding hooks.
- `InterviewPage.tsx` handles setup, answer turns, ending and insights with Axios/local state plus shared history queries. ChatInterface suppresses sources for INTERVIEW.
- Dashboard shows workspace repositories, recent work, authored open PRs/activity. `workspace_started_at` is independent of readiness. Sync status polls every 3s until READY/FAILED; summary progress fields have no writer.
- Styling lives in `tailwind.config.ts`, `styles/globals.css`, and reusable UI components; class-based dark mode, custom MarkdownRenderer, `utils/cn.ts`. Keep global sidebar navigation separate from repository subnav.

## Coding Conventions and Invariants

- Backend strict TypeScript targets ES2022/NodeNext; relative imports use **`.js`** even in `.ts` sources. Frontend uses bundler resolution, React JSX, `@/` alias, and unused-local/parameter checks. There is no shared root tsconfig.
- Feature files use `.routes.ts`, `.controller.ts`, `.service.ts`; singleton services coexist with object/function exports. Follow nearby style.
- Parameterized SQL/shared pool, release clients in `finally`, slow generation outside transactions. Avoid expanding existing pre-BEGIN connection holding during network calls.
- SQL rows are snake_case; DTOs vary. Direct arrays/objects, `{latest,history}`, `{success:true}` and `{error:string}` coexist; preserve consumer contracts.
- Inputs use manual checks, not Zod. LLM schemas use Google `Schema`/`Type`, converted for Ollama. JSON parsing/type casts are not complete runtime validation; align schemas/types/DB/UI.
- Domain types: `chat.types.ts`, `interviewTypes.ts`, `retrievalTypes.ts`, `summaryTypes.ts`; frontend contracts in `frontend/src/types/`. Summary types re-export the chunker's `FileASTMetadata`.
- Preserve independent AST inventory/chunks/summaries/import edges. LLM relationships are not verified graph facts; documentation is not authoritative executable behavior.
- Preserve indexing hashes/deletion/snapshot/counters. Schema/chunker/model changes may need explicit reindex: equal SHA skips sync.
- Preserve readiness error strings and SSE error events. Review's generic catch currently masks the controller's intended 409 mappings.
- Follow API/query-hook patterns and invalidation; review/interview also use Axios directly. Do not duplicate global error toasts.
- Logging uses `console` with subsystem tags. `README_DEBUG` logging is enabled unless explicitly disabled; Gemini structured responses are currently logged in full. Do not add secret/vector/prompt dumps.

## Development Commands

Run commands in the indicated package directory. In Windows PowerShell, use `npm.cmd`/`npx.cmd` if script policy blocks the `.ps1` launchers.

| Directory | Command | Purpose |
| --- | --- | --- |
| `backend/`, `frontend/` separately | `npm ci` | Install their lockfile dependencies |
| `backend/` | `docker compose up -d` | Start Postgres and both Redis instances |
| `backend/` | `npm run migrate` | Apply schema; changes the configured DB, including backfills |
| `backend/` | `npm run dev` | Watch API with tsx |
| `backend/` | `npm run worker` | Watch all queue consumers in separate terminal |
| `backend/` | `npm run build`; `npm start` | Compile to dist; start compiled API |
| `backend/` | `node dist/worker.js` | Compiled worker after build; no separate production-worker npm script |
| `backend/` | `npx tsc --noEmit` | Typecheck without build output |
| `backend/` | `npm test` | Node test runner with tsx, `src/**/*.test.ts` |
| `backend/` | `npm run parsers:sync`; `npm run parsers:verify` | Replace grammars from installed package; verify loads/real parse queries |
| `frontend/` | `npm run dev` | Vite dev server |
| `frontend/` | `npm run build`; `npm run preview` | TypeScript project build + Vite, then preview |
| `frontend/` | `npm run lint` | Existing lint script; ESLint 9 is paired with legacy `.eslintrc.cjs`, so configuration compatibility needs attention |

Tests cover AST/docs, documentation queries, module heuristics, reranking and interview focus. No frontend tests, DB/queue integration suite or retrieval eval harness. `backend/test.js` is a manual live Gemini probe. Build does not copy schema/WASM into dist: retain assets/backend working directory.

## Environment and External Services

Names and purposes only; never copy actual `.env` values into documentation/logs.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection string |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Required backend Clerk configuration |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Optional Clerk/Svix verification secret; webhook returns unavailable if absent |
| `PORT`, `CORS_ORIGIN` | API listener and permitted frontend origin |
| `GEMINI_API_KEY` | Explicit Gemini generation key; embeddings instantiate GoogleGenAI with empty options and rely on SDK environment discovery |
| `REDIS_CACHE_URL`, `REDIS_QUEUE_URL` | Separate cache and durable queue/coordination instances |
| `README_DEBUG` | Toggle documentation ingestion/retrieval debug logging |
| `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_BASE_URL` | Frontend Clerk key and API base including `/api` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | PostgreSQL container initialization settings in Compose |

`config/env.ts` loads dotenv and validates DB/Clerk at import; Redis/Gemini/debug read `process.env` directly. Run from backend. Only frontend has `.env.example`. API defaults to 4000, Vite 5173. Run local Ollama with the model available; no application host/model env wrapper exists.

## Known Gotchas to Check Before Extending

- **Index recovery:** generation failures outside the transaction catch can strand INDEXING; post-commit enqueue failure/retry can repeat counters. No run IDs/completion records; stale skips do not repair progress. Not exactly-once.
- **Summary recovery:** per-worker concurrency 1 is not global. `reconverge()` can re-add terminal failures beyond three attempts; SHA-only checks do not cover every in-flight Phase 1 race.
- **Review metadata/concurrency:** stored model is `gemini-2.0-flash` despite runtime `gemini-3.6-flash`. Concurrent generation can produce multiple latest reviews. See above for same-head findings caching and masked readiness errors.
- **Legacy UI/SQL:** dashboard pending links target nonexistent `/pull-requests/<id>`; recent Q&A uses old `?tab=chat`. Unused `touchWorkspaceSession()` queries nonexistent `workspace_sessions`.
- **Documentation drift:** README's old flat services layout, exact-symbol retrieval, naming-based test discovery and planned SSE/finding discussions differ from implementation. It omits worker/two Redis setup. CLAUDE.md also misstates chat provider, interview counters, PR routing and consistency guarantees.

## Before Making Changes

1. Check working-tree edits and local instructions; do not overwrite unrelated work.
2. Search callers, route mounts, frontend consumers and types before changing a shared service or response.
3. Trace internal/Clerk/GitHub IDs and authorization for every supplied repository/review/session identifier.
4. Check schema upgrade behavior, hash/reindex compatibility, deletion/rename handling, queue retries and readiness semantics.
5. Check both server Redis invalidation and frontend query keys; emit completion events only after durable writes.
6. Keep AI schemas, source authority/citations, budgets and model routing explicit; do not silently alter retrieval semantics.
7. Run relevant tests/typechecks/builds/parser verification. Validate SQL, auth, queues and retrieval with an indexed repository; compilation alone is insufficient.
