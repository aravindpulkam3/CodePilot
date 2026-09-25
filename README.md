<div align="center">

# CodePilot

### Repository-aware AI for pull request review, codebase Q&A, and technical interviews — grounded in an index of the actual code.

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL%20%2B%20pgvector-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis%20%2B%20BullMQ-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white)

![Tests](https://img.shields.io/badge/tests-211%20passing-2ea44f?style=flat-square)
![Status](https://img.shields.io/badge/status-active%20development-blue?style=flat-square)

</div>

---

CodePilot connects to your GitHub repositories, builds a **structural and semantic index** of each codebase, and uses it to power three things: **AI pull request reviews** that understand the blast radius of a change, **natural-language Q&A** with exact, inspectable citations, and a **technical interview mode** that questions a candidate about a real repository instead of generic trivia.

The index combines **tree-sitter AST chunking**, a **file-level import graph**, **3072-dimension embeddings in pgvector**, and **documentation/config files as first-class evidence**. Indexing itself makes **zero LLM calls**: it is deterministic, commit-pinned, and crash-safe.

> **Core idea:** vector search alone is not enough for code. CodePilot pairs semantic similarity with the explicit structure of a repository — what imports what, which tests cover which files, what the README and manifests actually declare — and tells the model exactly where every piece of context came from.

---

## Contents

- [Features](#-features)
- [Engineering Highlights](#-engineering-highlights)
- [System Architecture](#️-system-architecture)
- [How Indexing Works](#-how-indexing-works)
- [How Retrieval Works](#-how-retrieval-works)
- [Tech Stack](#️-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Testing & Evaluation](#-testing--evaluation)
- [Known Limitations](#️-known-limitations)
- [Roadmap](#️-roadmap)
- [Design Principles](#-design-principles)

---

## ✨ Features

### 🔎 AI Pull Request Review
- Structured reviews with an **overall score (1–100)**, a **risk level** (Low → Critical), and per-finding **severity, category, file, line, recommendation, and code suggestion**.
- **Enclosing code comes from the PR head**, not the default branch: each changed file is fetched at `head_sha`, AST-chunked in memory, and every diff line is verified against it before any context is attached.
- **Blast-radius retrieval** through the import graph — the changed files' **dependents**, **dependencies**, and **related tests** — plus semantic search for code with no explicit link.
- Flags **README ↔ code contradictions** as their own `documentation` finding category.
- **Follow-up AI chat** on the whole review *or* on a single finding, restored automatically when you reopen the PR.

### 💬 Codebase Q&A
- Ask anything about a repository and get a **streamed answer (SSE)** with numbered `[n]` citations to code, documentation, and import relationships.
- **Sources are exact prompt provenance** — the Source Inspector shows precisely what the model saw (including truncation), never a re-run search after the fact.
- **Conversation-aware retrieval**: short anaphoric follow-ups ("why did they choose that?") are resolved against the previous question before embedding, with no extra LLM call.
- **Relevance-and-role budgeting** decides how much room code, docs, and the repository overview each get, instead of dumping everything that matched.

### 🎤 Repository-Grounded Technical Interviews
- An interviewer that asks questions about **the actual repository** and evaluates answers against retrieved code and docs.
- **Coverage-driven**: tracks visited files and modules and deliberately moves to unexplored parts of the codebase instead of orbiting one file.
- Four explicit next actions — `FOLLOW_UP`, `DEEP_DIVE`, `SIMPLIFY`, `NEW_TOPIC` — with **adaptive difficulty** and a running digest of the candidate's **known gaps**.
- The model's proposed next focus is **validated against the real index** before it is accepted; a hallucinated file path is rejected.
- A **final holistic assessment** is generated once the interview ends.

### 🗂️ Workspace
- Browse your GitHub repositories (via Clerk GitHub OAuth) or **import any public repository by URL**.
- A dashboard with recent work, pending PRs, and an activity log.
- Every repository gets its own workspace with real, shareable routes: `/repositories/:id/pulls/:n`, `/chat/:sessionId`, `/interview/:sessionId`.
- **Live indexing progress** (`chunksDone / chunksTotal`), with a one-click Retry if a run fails.

---

## 🏆 Engineering Highlights

| | |
|---|---|
| **Deterministic indexing** | No LLM calls at index time. Repository and module "profiles" (purpose, tech stack, scripts, runtime services, feature modules, most-referenced files) are **derived at query time** from the README, `package.json`, and `docker-compose` — cached under the indexed commit SHA, so they can never describe the wrong revision. |
| **Crash-safe, fenced indexing runs** | Each sync claims a **run token** and pins a **target SHA**. Chunk jobs do slow work *outside* a transaction, then commit under `SELECT … FOR UPDATE` only if they still belong to the current run — with an idempotent **completion receipt**. Stale, superseded, or retried-after-commit jobs can never write or double-count. |
| **Honest delta indexing** | Incremental syncs use GitHub's compare API, but a delta that isn't provably complete (300-file cap, force-push / diverged history, vanished base commit) **triggers a full rebuild** instead of silently producing a partial index. |
| **Failure never masquerades as success** | A corrupt parser grammar throws instead of returning "no symbols"; a run that fails mid-way **invalidates** the index; retrieval refuses an invalid index with an explicit error instead of answering from stale data. |
| **Revision-correct PR review** | Changed code is mapped at the PR's own head commit and verified line-by-line. The prompt explicitly states that surrounding context comes from the default branch, so the model never confuses the two. |
| **Exact citation provenance** | Q&A persists a snapshot of exactly what was rendered into the prompt; displayed sources are derived only from that snapshot. |
| **Split-provider LLM design** | Cloud **Gemini** (structured JSON output) for reviews and interview turns; local **Ollama** `qwen2.5-coder:7b` for streamed Q&A and final assessments — chosen per cost/latency trade-off. |
| **Two isolated Redis instances** | A volatile LRU cache and a persisted, `noeviction` queue instance, so cache pressure can never evict a job, lock, or rate-limit counter. |

---

## 🏗️ System Architecture

```mermaid
flowchart LR
    subgraph Client
        UI["React + Vite SPA<br/>TanStack Query · Clerk"]
    end

    subgraph Backend ["Node.js / TypeScript"]
        API["Express API<br/>auth · rate limits · SSE"]
        WORKER["BullMQ Worker<br/>sync + index jobs"]
    end

    subgraph Data
        PG[("PostgreSQL 17 + pgvector<br/>embeddings · import graph · sessions")]
        RQ[("Redis :6380 — queue<br/>noeviction · AOF")]
        RC[("Redis :6379 — cache<br/>allkeys-lru")]
    end

    subgraph External
        GH["GitHub REST API"]
        CLERK["Clerk<br/>auth + GitHub OAuth"]
        GEM["Gemini<br/>review · interview · embeddings"]
        OLL["Ollama (local)<br/>qwen2.5-coder:7b"]
    end

    UI <-->|"REST / SSE"| API
    API -->|"enqueue"| RQ
    RQ --> WORKER
    API <--> PG
    WORKER --> PG
    API <--> RC
    WORKER --> RC
    API --> GH
    WORKER --> GH
    API --> CLERK
    WORKER -->|"embeddings"| GEM
    API --> GEM
    API --> OLL
```

The API **never indexes inline** — it only enqueues jobs. A separate worker process consumes them, so long-running syncs never block requests and survive restarts.

---

## 🧠 How Indexing Works

```mermaid
flowchart TD
    A["Start Working / Retry"] --> B["API enqueues one sync job<br/>(deduplicated per repository)"]
    B --> C["Worker claims an indexing run<br/>run token + pinned target SHA"]
    C --> D{"Valid previous index<br/>and a complete delta?"}
    D -->|"yes"| E["Fetch only changed files"]
    D -->|"no"| F["Invalidate → guarded clear<br/>→ fetch full Git tree"]
    E --> G["Sorted file list → 50-file chunk jobs<br/>deterministic ids · concurrency 4"]
    F --> G

    subgraph OUT ["Outside any transaction"]
        H["tree-sitter AST chunks<br/>doc + config chunks<br/>Gemini embeddings<br/>import extraction"]
    end

    G --> H
    H --> I["Short transaction<br/>row lock → re-check run token<br/>write rows + completion receipt"]
    I --> J{"All receipts in?"}
    J -->|"no"| K["Other chunk jobs continue"]
    J -->|"yes"| L["Resolve pending imports<br/>stamp last_indexed_sha · READY"]
```

**What gets indexed** — one rule decides it, applied before anything is downloaded:

| Kind | Files | How it's chunked |
|---|---|---|
| **Code** | TypeScript (`.ts`, `.tsx`), JavaScript (`.js`, `.jsx`), Python, Go, C++ | tree-sitter AST: functions, classes, methods, interfaces, and top-level code; oversized symbols are split |
| **Documentation** | `README`, `ARCHITECTURE`, `CONTRIBUTING` (any depth) | Structure-aware, split on headings |
| **Config** | `package.json`, `docker-compose*.yml`, `Dockerfile*`, `.env.example`, `tsconfig*.json`, `*.sql`, `.github/workflows/*` | One byte-exact row per file, so manifests can be parsed again at query time |

Lockfiles, `node_modules/`, `dist/`, and binaries are excluded. Every row carries the commit SHA it was built from, so code and docs can never disagree on revision.

**Import graph.** Relative imports are resolved file → file. Imports whose target lives in a chunk that hasn't committed yet are stored as *unresolved* and reconciled in the final transaction, so cross-chunk edges are never lost.

---

## 🔍 How Retrieval Works

Three modes, three different objectives — deliberately **not** one shared pipeline:

| Mode | Objective | Strategy |
|---|---|---|
| **PR Review** | *Blast radius* — what could this change break? | PR-head enclosing code + import-graph expansion (dependents, dependencies, tests) + semantic recall → merge → rerank → budget |
| **Q&A** | *Relevance* — answer this question well | Repo-wide semantic code search + unrestricted doc search + repository profile + one-hop graph neighbours of the top match |
| **Interview** | *Coverage* — explore the whole repo, not one file | Three blocks per turn: **Grounding** (judge the answer), **Local** (drill into the current focus), **Frontier** (unvisited modules) |

### PR Review pipeline

```mermaid
flowchart TD
    PR["Pull request"] --> HEAD["Changed files fetched at head_sha<br/>AST-chunked in memory · every line verified"]
    PR --> GRAPH["Import graph<br/>dependents · dependencies · related tests"]
    PR --> SEM["Semantic search"]
    PR --> DOCQ["Doc query from PR title + description"]
    GRAPH --> CODE["pgvector: fetch code for graph-selected files"]
    CODE --> MERGE["Merge + dedupe<br/>provenance preserved"]
    SEM --> MERGE
    MERGE --> RANK["Bounded rerank<br/>max + 0.25 × Σ(other sources)"]
    RANK --> BUDGET["Greedy context budget"]
    HEAD --> PROMPT["Prompt: diff + enclosing code at PR head<br/>+ default-branch context + documentation"]
    BUDGET --> PROMPT
    DOCQ --> PROMPT
    PROMPT --> OUT["Gemini structured output<br/>score · risk level · findings"]
```

Candidate sources are weighted by how strongly they indicate relevance:

| Source | Weight | Meaning |
|---|:---:|---|
| `changed_file` | 1.00 | A chunk of a file the PR modifies |
| `related_test` | 0.85 | A test covering a changed file — encodes intended behaviour |
| `graph_dependent` | 0.80 | A caller — what breaks if this changes |
| `graph_dependency` | 0.65 | A callee — relevant, but the call site is usually in the diff |
| `semantic_chunk` | 0.45 | General recall for code with no explicit link |

Highly shared files (fan-in above 30 non-test callers) are suppressed so a utility module can't flood the context.

### Source authority

Code, documentation, and config are retrieved **separately and never merged**, and every prompt states their authority explicitly: **docs** are authoritative for stated intent and setup, **config** for declared dependencies and runtime services, and **code** for current behaviour. When they disagree, the model is told which to trust for what.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router, Clerk, Prism.js, Sonner |
| **Backend** | Node.js, TypeScript (ESM), Express, raw SQL via `pg` (no ORM) |
| **Data** | PostgreSQL 17 + pgvector (`VECTOR(3072)`), Redis 7 ×2 |
| **Jobs** | BullMQ with native deduplication, `rate-limiter-flexible` |
| **Code analysis** | `web-tree-sitter` (WebAssembly grammars, verified at build time) |
| **AI** | Gemini (`gemini-embedding-001` embeddings, structured generation), Ollama (`qwen2.5-coder:7b`) |
| **Auth & integrations** | Clerk (sessions + GitHub OAuth tokens, Svix-verified webhooks), GitHub REST API |
| **Infra** | Docker Compose |

---

## 📂 Project Structure

```text
backend/
├── parsers/                 # tree-sitter .wasm grammars (TS, TSX, JS, Python, Go, C++)
├── scripts/                 # parser sync/verify, retrieval evaluation harness
├── docker-compose.yml       # Postgres + pgvector, redis-cache, redis-queue
└── src/
    ├── server.ts            # API process
    ├── worker.ts            # BullMQ worker process (sync + index)
    ├── config/              # env, Postgres pool, Redis clients, queues
    ├── db/                  # schema.sql + migrate.ts
    ├── features/
    │   ├── repository/      # GitHub sync, indexing pipeline, import graph
    │   ├── review/          # PR review, head-revision context, review prompt
    │   ├── chat/            # Q&A + review/finding chat, SSE, context providers
    │   ├── interview/       # interview engine, focus resolution, prompt
    │   ├── dashboard/       # recent work, pending PRs, activity log
    │   ├── user/            # user profile sync from Clerk
    │   └── webhook/         # Clerk webhook (Svix-verified)
    ├── infrastructure/
    │   ├── chunking/        # AST chunker, documentation/config chunker
    │   ├── embedding/       # Gemini embeddings
    │   ├── github/          # GitHub REST client
    │   ├── llm/             # Gemini + Ollama services
    │   └── retrieval/       # semantic search, reranker, budget, repo/module profiles
    ├── middleware/          # auth, rate limiting, error handling
    └── shared/              # prompt/citation rendering, import resolver, cache, validation

frontend/src/
├── pages/                   # Dashboard, Repositories, repository workspace pages
├── components/              # chat, review, sources inspector, layout, ui
├── services/api/            # one axios client + per-feature API modules
├── hooks/                   # TanStack Query hooks wrapping each API module
└── constants/routes.ts      # nested /repositories/:repositoryId/... routes
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js 22.18+**
- **Docker** (Postgres + both Redis instances)
- A **Clerk** application with **GitHub** enabled as a sign-in provider (add the `repo` scope to work with private repositories)
- A **Gemini API key**
- **Ollama** running locally, with the Q&A model pulled:
  ```bash
  ollama pull qwen2.5-coder:7b
  ```

### 1. Start the infrastructure

```bash
cd backend
docker-compose up -d
```

This starts PostgreSQL 17 with pgvector on `5432`, `redis-cache` on `6379`, and `redis-queue` on `6380`.

### 2. Configure environment variables

**`backend/.env`**
```env
PORT=4000
CORS_ORIGIN=http://localhost:5173

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workspace

# Optional — these are the defaults
REDIS_CACHE_URL=redis://localhost:6379
REDIS_QUEUE_URL=redis://localhost:6380

CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
# Optional — only needed if the Clerk webhook can reach your server
CLERK_WEBHOOK_SIGNING_SECRET=

GEMINI_API_KEY=...
```

**`frontend/.env`** (see `frontend/.env.example`)
```env
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_API_BASE_URL=http://localhost:4000/api
```

### 3. Install, migrate, and verify parsers

```bash
cd backend
npm install
npm run migrate          # applies schema.sql (idempotent; enables pgvector)
npm run parsers:verify   # loads every grammar and runs a real parse + query
```

### 4. Run it — three processes

```bash
# Terminal 1 — API (http://localhost:4000)
cd backend && npm run dev

# Terminal 2 — worker (required: sync and indexing do nothing without it)
cd backend && npm run worker

# Terminal 3 — frontend (http://localhost:5173)
cd frontend && npm install && npm run dev
```

> ⚠️ **Don't forget the worker.** The API only enqueues jobs. Without the worker, indexing jobs wait in Redis with no error; they run safely as soon as it starts.

Sign in, open a repository, and click **Start Working** to index it.

---

## 🧪 Testing & Evaluation

```bash
cd backend && npm test    # 201 tests
cd frontend && npm test   # 10 tests
```

Tests use Node's built-in test runner and cover the deterministic core, with no DB or LLM needed: AST and documentation chunking, import resolution, reranking, module discovery, repository-profile parsing, PR-head changed-code mapping, interview focus resolution, citation provenance, queue deduplication, input validation, and safe error logging.

**Retrieval evaluation harness.** `scripts/evalRetrieval.ts` runs 15 fixed cases across Q&A, Review, and Interview against a live index. It calls the real retrieval and prompt builders, **never a generation model**, and records exactly what *would* be sent. Expected evidence is matched by repo-relative path.

```bash
npx tsx scripts/evalRetrieval.ts --out baseline
npx tsx scripts/evalRetrieval.ts --out candidate
npx tsx scripts/evalRetrieval.ts --compare baseline candidate
```

The harness gated removing the old LLM-summary layer: no case regressed, while architecture-overview recall rose from **0.33 → 1.00** and setup questions from **0.50 → 1.00**.

---

## ⚠️ Known Limitations

CodePilot is under active development and currently runs as a local development setup. Known gaps:

- **No push webhook** — indexes refresh just-in-time (as a delta) when a review, Q&A, or interview session starts.
- **Import graph coverage** — complete for TS/JS relative imports; TS path aliases, Python absolute imports, and Go/C++ imports aren't extracted yet, so graph-driven retrieval is weaker for those.
- **Large PRs** — reviews currently see a PR's first 30 changed files.
- **Pure dense retrieval** — no lexical/BM25 hybrid yet. pgvector ANN indexes cap at 2000 dimensions, so 3072-dim similarity search is a sequential scan, which is why the non-code file set is a bounded allowlist.
- **Very large repositories** — a Git tree too large for GitHub to return untruncated (>100k entries / 7 MB) is rejected with a clear failure.

---

## 🗺️ Roadmap

**Shipped**

- [x] AST-aware chunking for 5 languages, with verified parser grammars
- [x] Documentation and config files as first-class, revision-matched evidence
- [x] Import graph with cross-chunk pending-import reconciliation
- [x] Background indexing on BullMQ with run-token fencing and completion receipts
- [x] Incremental delta indexing with automatic full-rebuild fallback
- [x] Deterministic repository and module profiles (no LLM summaries)
- [x] Graph-driven PR review with PR-head enclosing code
- [x] Bounded multi-source reranking and context budgeting
- [x] Streaming Q&A with exact-provenance citations and a Source Inspector
- [x] Follow-up chat on reviews and individual findings
- [x] Coverage-driven, adaptive repository interviews
- [x] Retrieval evaluation harness

**Next**

- [ ] Filename-sibling test discovery (`foo.ts` → `foo.test.ts`, pytest `test_*.py`)
- [ ] `tsconfig` path-alias resolution and Python/Go import extraction
- [ ] Full PR file pagination and a single unified review context budget
- [ ] Source/citation display for interviews
- [ ] Smarter interview adaptation after repeated misses on the same topic
- [ ] Lexical + dense hybrid retrieval
- [ ] GitHub push webhook for proactive re-indexing

---

## 🎯 Design Principles

1. **Deterministic before generative.** Anything that can be derived from the code, the graph, or the manifests is derived, not generated.
2. **Structure + semantics.** The import graph decides *which* files matter; embeddings decide *which parts* of them.
3. **Be honest about revisions.** Every piece of context knows which commit it came from, and the prompt says so.
4. **Provenance is exact.** A cited source is exactly what the model saw, not a best guess reconstructed afterwards.
5. **Fail loudly.** A partial, stale, or corrupt index is refused, never silently served.
6. **Measure retrieval changes.** Changes to what reaches a prompt are checked against the evaluation harness, not just reasoned about.
