# AI-Powered Code Review & Codebase Intelligence Platform

A production-grade platform that automates pull request reviews, performs intelligent repository indexing, and enables natural language interaction with entire codebases using Retrieval-Augmented Generation (RAG).

The platform combines AST-aware code parsing, vector search, structured LLM outputs, and GitHub integration to deliver senior engineer-level code reviews while allowing developers to ask questions about their repositories in real time.

---

# Features

- Automated AI-powered pull request reviews
- Repository-wide Codebase Q&A using RAG
- AST-aware code chunking using Tree-sitter
- Incremental (Delta) indexing for fast embedding updates
- Semantic code search using pgvector
- Structured JSON AI responses with schema validation
- Commit staleness detection
- Persistent review history and chat sessions
- Multi-provider LLM architecture
- Modular SOLID-based backend design

---

# System Architecture

```
                               React Frontend
      (Dashboard • Diff Viewer • Repository Chat • Review History)
                                      │
                             HTTP / REST / SSE
                                      │
┌────────────────────────────────────────────────────────────────────────┐
│                         Express.js Backend                             │
│                                                                        │
│  Clerk Authentication                                                  │
│  GitHub OAuth & REST APIs                                              │
│  GitHub Push Webhooks                                                  │
│                                                                        │
│               Review Service (Business Logic)                          │
│                        │                │                               │
│                        │                │                               │
│        Prompt Builder  │      Retrieval Service                        │
│                        │                │                               │
│                 Repository Indexing Service                            │
│                        │                │                               │
│                 Tree-sitter AST Parser                                 │
│                        │                │                               │
│              Generic LLM Service Interface                             │
│          (Gemini / OpenRouter / Groq Providers)                        │
└────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                      PostgreSQL + pgvector Database
```

---

# Engineering Highlights

## AST-Based Semantic Code Chunking

Instead of splitting files using fixed character limits, the platform parses source code into Abstract Syntax Trees using Tree-sitter.

Each embedding represents complete language-native structures such as:

- Functions
- Methods
- Classes
- Arrow Functions

Supported languages include:

- TypeScript
- JavaScript
- Python
- Go
- C++

Each chunk is enriched with metadata including:

- File path
- Language
- Symbol type
- Symbol name

This preserves syntactic integrity and significantly improves retrieval quality.

---

## Delta Indexing Pipeline

Re-indexing an entire repository after every commit is inefficient.

The platform performs **incremental indexing** using the GitHub Compare API.

Pipeline:

1. Compare latest indexed commit with repository HEAD
2. Detect added, modified and deleted files
3. Re-embed only changed files
4. Remove embeddings belonging to deleted files
5. Update `last_indexed_sha` after successful completion

Benefits:

- Faster indexing
- Lower embedding cost
- Reduced API token consumption
- Production-friendly scalability

---

## Intelligent Code Retrieval

Repository knowledge is stored using **pgvector** inside PostgreSQL.

Retrieval pipeline:

- Cosine similarity search
- MMR-inspired diversity filtering
- File diversity threshold
- Context ranking before LLM inference

This prevents repetitive utility files from dominating the context window while improving answer diversity.

---

## AI Code Review Engine

Every review follows a structured pipeline.

Features include:

- JSON Schema enforced LLM outputs
- Categorized review findings
- Atomic PostgreSQL transactions
- Persistent review history
- Audit logging
- Commit hash tracking

Review categories:

- Correctness
- Security
- Performance
- Maintainability
- Testing
- Best Practices

---

## Repository Chat (RAG)

Developers can ask natural language questions about an indexed repository.

Examples:

- Explain the authentication flow
- Where is JWT validation implemented?
- Which service creates embeddings?
- How is repository synchronization handled?

The retrieval pipeline automatically fetches the most relevant AST chunks before generating answers.

---

## Commit Staleness Detection

Each review stores the corresponding Git commit SHA.

Whenever new commits are pushed:

- Older reviews are automatically marked as stale
- Users are prompted to generate a fresh review
- Prevents developers from relying on outdated AI feedback

---

# Technology Stack

## Backend

- Node.js
- TypeScript
- Express.js
- PostgreSQL
- pgvector
- Clerk Authentication
- Tree-sitter (WebAssembly)
- Google Gemini API
- GitHub REST API

---

## Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- TanStack React Query
- Lucide React

---

# Project Structure

```
backend/
│
├── parsers/
│
├── src/
│   ├── config/
│   ├── controllers/
│   ├── middleware/
│   ├── promptBuilders/
│   ├── routes/
│   └── services/
│       ├── astChunking.service.ts
│       ├── chat.service.ts
│       ├── github.service.ts
│       ├── llm.service.ts
│       ├── repositoryIndex.service.ts
│       ├── repositorySync.service.ts
│       ├── retrieval.service.ts
│       └── review.service.ts
│
└── docker-compose.yml


frontend/
│
├── src/
│   ├── components/
│   ├── hooks/
│   ├── pages/
│   ├── services/
│   └── types/
│
└── vite.config.ts
```

---

# Getting Started

## Prerequisites

- Node.js 18+
- Docker Desktop
- PostgreSQL (via Docker)
- Clerk Account
- Google AI Studio API Key

---

## Backend Environment

```env
PORT=5000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_code_review

CLERK_SECRET_KEY=your_clerk_secret_key

GEMINI_API_KEY=your_gemini_api_key
```

---

## Frontend Environment

```env
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key

VITE_API_BASE_URL=http://localhost:5000/api
```

---

## Database Setup

Start PostgreSQL using Docker.

```bash
cd backend

docker-compose up -d
```

Enable pgvector.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Initialize the project schema.

---

## Install Tree-sitter Parsers

Place the following `.wasm` files inside:

```
backend/parsers/
```

- tree-sitter-typescript.wasm
- tree-sitter-javascript.wasm
- tree-sitter-python.wasm
- tree-sitter-go.wasm
- tree-sitter-cpp.wasm

---

## Running the Project

### Backend

```bash
cd backend

npm install

npm run dev
```

### Frontend

```bash
cd frontend

npm install

npm run dev
```

---

# Roadmap

### Completed

- GitHub OAuth & Repository Synchronization
- Pull Request Diff Viewer
- AI Code Review Engine
- Structured Review Persistence
- Tree-sitter AST Chunking
- Delta Repository Indexing
- pgvector-based Semantic Retrieval
- Repository Codebase Chat

### In Progress

- Server-Sent Events (Streaming Responses)
- Clickable Source Citations
- Sliding Window Conversation Memory

### Planned

- Inline AI Discussion Threads for Review Findings
- AI Interview Mode using Repository Context
- Multi-Repository Knowledge Workspace
- Support for Additional LLM Providers
- Advanced Repository Analytics

---

# Design Principles

- SOLID Architecture
- Separation of Concerns
- Provider-Agnostic LLM Layer
- Transactional Data Integrity
- Incremental Indexing
- Retrieval-Augmented Generation
- Production-Ready Backend Design