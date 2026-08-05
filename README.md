AI-Powered Code Review & Codebase Intelligence Platform
A production-grade, enterprise-ready platform designed to automate code reviews, provide real-time architectural insights, and enable interactive codebase Q&A using advanced Retrieval-Augmented Generation (RAG). Built with modular, SOLID-compliant backend design and AST-level parsing, this platform transforms raw git patches into actionable, senior-engineer-level reviews while allowing developers to interact with their codebases directly.

🏗 System Architecture Overview
The system is designed with strict separation of concerns, decoupling the AI model providers from prompt engineering and business logic.

┌─────────────────────────────────────────────────────────────────────────┐
│                              React Frontend                             │
│       (Dashboard, Diff Viewer, Stale Commit Banners, Chat Panel)        │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP / REST / SSE
┌────────────────────────────────────▼────────────────────────────────────┐
│                             Express Backend                             │
│ ┌───────────────────┬──────────────────────────┬──────────────────────┐ │
│ │  Clerk Auth Guards│   GitHub REST & OAuth    │ GitHub Push Webhooks │ │
│ └─────────┬─────────┴────────────┬─────────────┴──────────┬───────────┘ │
│           │                      │                        │             │
│ ┌─────────▼──────────────────────▼────────────────────────▼───────────┐ │
│ │                          Review Service                             │ │
│ │            (Orchestrates diff analysis & AST Context)              │ │
│ └─────────┬──────────────────────┬────────────────────────┬───────────┘ │
│           │                      │                        │             │
│ ┌─────────▼─────────────┐ ┌──────▼────────────────┐ ┌─────▼───────────┐ │
│ │ CodeReviewPromptBuilder│ │   Indexing Service   │ │ RetrievalService│ │
│ │  (Schema & AST Context)│ │  (Tree-Sitter Delta) │ │  (pgvector MMR) │ │
│ └─────────┬─────────────┘ └──────┬────────────────┘ └─────┬───────────┘ │
│           │                      │                        │             │
│ ┌─────────▼──────────────────────▼────────────────────────▼───────────┐ │
│ │                     Generic LLM Service Interface                   │ │
│ │               (Gemini 2.0 Flash / OpenRouter / Groq)                │ │
│ └────────────────────────────────┬────────────────────────────────────┘ │
└──────────────────────────────────┼──────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────────┐
│                        PostgreSQL + pgvector                            │
│ ┌─────────────┬─────────────┬────────────────┬────────────────────────┐ │
│ │ app_users   │ reviews     │review_findings │repository_embeddings  │ │
│ ├─────────────┼─────────────┼────────────────┼────────────────────────┤ │
│ │ repositories│review_msg...│chat_sessions   │chat_messages           │ │
│ └─────────────┴─────────────┴────────────────┴────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘

🌟 Key Engineering Accomplishments
1. Abstract Syntax Tree (AST) Chunking
Rather than slicing source code by arbitrary character lengths, the platform uses Tree-sitter (WebAssembly) to parse files into Abstract Syntax Trees.

Logical Chunking: Extracts language-native blocks—function_declaration, class_declaration, method_definition, and arrow function variable declarators across .ts, .tsx, .js, .jsx, .py, .go, and .cpp files.

Syntactic Integrity: Ensures function bounds and logic remain preserved so the LLM evaluates complete logic units rather than broken lines.

Enriched Metadata: Injects file paths, languages, symbol types, and symbol names directly into the content string prior to embedding generation.

2. Surgical Delta Indexing
To prevent API token waste and reduce re-indexing latency, the platform implements an incremental update pipeline:

Commit Compare Strategy: Leverages the GitHub Compare API (/compare/{last_indexed_sha}...{current_head_sha}) to isolate changed files.

Targeted Operations: Only deletes, re-chunks, and re-embeds vectors for added or modified files, while automatically purging embeddings for removed files.

Pointer Tracking: Updates the repository's last_indexed_sha in PostgreSQL upon successful transaction completion.

3. Context-Aware AI Review Pipeline
Structured Enforcements: Uses model-native JSON Schema enforcement (via Gemini 2.0 Flash) to enforce structural validation.

Categorized Findings: Classifies feedback under Correctness, Security, Performance, Maintainability, Testing, and Best Practices.

Atomic PostgreSQL Transactions: Stores parent reviews, child line-by-line findings, and audit logs inside atomic SQL transactions (BEGIN...COMMIT).

Commit Staleness Detection: Tracks commit hashes (head_sha) to detect outdated reviews and alert users when new code has been pushed since the last review.

4. Diverse Vector Retrieval (MMR-inspired)
Similarity Search: Executes cosine similarity searches over vectors stored in PostgreSQL via the pgvector extension.

Diversity Filters: Enforces a file diversity threshold to prevent small utility files (e.g., helper scripts) from flooding the retrieved context window.

🛠 Tech Stack
Backend
Runtime: Node.js (TypeScript, ESM execution)

Framework: Express.js

Database: PostgreSQL with pgvector extension

ORM/Driver: pg (Pool-based connection management)

Authentication: Clerk (@clerk/express)

Parsing: Web-Tree-Sitter (WASM)

AI SDK: @google/genai (Gemini 2.0 Flash)

Frontend
Core: React.js, Vite, TypeScript

State & Query: TanStack React Query (Cache management, mutations, invalidation)

Styling: Tailwind CSS

Icons: Lucide React

📂 Project Structure
.
├── backend/
│   ├── parsers/                   # WebAssembly language parsers (.wasm)
│   ├── src/
│   │   ├── config/                # Environment variables and Pool config
│   │   ├── controllers/           # Route handlers (Review, Sync, GitHub, Webhooks)
│   │   ├── middleware/            # Auth guards (Clerk middleware)
│   │   ├── promptBuilders/        # LLM prompt templates & JSON schemas
│   │   ├── routes/                # Express API routes
│   │   └── services/              # Core business logic
│   │       ├── astChunking.service.ts
│   │       └── chat.service.ts
│   │       ├── github.service.ts
│   │       ├── llm.service.ts
│   │       ├── repositoryIndex.service.ts
│   │       ├── repositorySync.service.ts
│   │       ├── retrieval.service.ts
│   │       └── review.service.ts
│   └── docker-compose.yml
└── frontend/
    ├── src/
    │   ├── components/            # Reusable UI components (Cards, Headers, Diff Viewer)
    │   ├── hooks/                 # Custom React Query hooks (useGitHub, useReviews, etc.)
    │   ├── pages/                 # Main routes (Dashboard, RepoDetails, PRDetails)
    │   ├── services/              # API client wrapper
    │   └── types/                 # Strongly-typed interface definitions
    └── vite.config.ts

    Setup & Local Development
1. Prerequisites
Node.js: v18+

Docker Desktop: Installed and running

Clerk Account: For API keys and OAuth configurations

Google AI Studio API Key: For Gemini model integration

2. Environment Setup
Backend (backend/.env)
Code snippet
PORT=5000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_code_review
CLERK_SECRET_KEY=your_clerk_secret_key
GEMINI_API_KEY=your_gemini_api_key
Frontend (frontend/.env)
Code snippet
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
VITE_API_BASE_URL=http://localhost:5000/api
3. Database Initialization (Docker)
Start the PostgreSQL container with pgvector preinstalled:

Bash
cd backend
docker-compose up -d
Execute schema initialization in PostgreSQL:

SQL
CREATE EXTENSION IF NOT EXISTS vector;

-- Key schema elements: repositories, reviews, review_findings, repository_embeddings, etc.
4. Downloading AST Parsers
Ensure language .wasm binaries sit within backend/parsers/:

tree-sitter-typescript.wasm

tree-sitter-javascript.wasm

tree-sitter-python.wasm

tree-sitter-go.wasm

tree-sitter-cpp.wasm

5. Running the Application
Bash
# Terminal 1: Backend
cd backend
npm install
npm run dev

# Terminal 2: Frontend
cd frontend
npm install
npm run dev
🚀 Roadmap & Future Plans
[x] Milestone 1: Core OAuth & Repository Sync

Clerk Auth integration and GitHub repository caching.

[x] Milestone 2: Pull Request Diff Viewer & Metadata

Custom line-by-line colored diff rendering.

[x] Milestone 3: Categorized AI Reviews & Persistence

Structured output review storage with SQL transactions.

[x] Milestone 4: RAG Foundation (Tree-sitter AST & pgvector)

Function-level chunking and Delta Indexing pipeline.

[ ] Milestone 5: Interactive Codebase Q&A (In Progress)

Server-Sent Events (SSE): Real-time response streaming for repository chats.

Clickable Citations: Returning context line ranges (start_line, end_line) so users can jump to relevant source code chunks directly.

Sliding Window History: PostgreSQL-backed session memory capped via ORDER BY created_at DESC LIMIT 10 for token efficiency.

[ ] Milestone 6: Inline Finding Chat Threads

Contextual sliding drawer to question specific AI findings directly on the diff page.

[ ] Milestone 7: AI Interview Mode

Interactive technical prep mode where the AI acts as a senior interviewer, evaluating solutions against codebase context without giving away direct answers.