# CodePilot: AI Codebase Intelligence & Review Platform

**A repository-aware AI platform for automated pull request reviews and natural language interaction with codebases.**

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)

CodePilot combines **AST-aware code parsing**, **hierarchical repository summarization**, **structural dependency indexing**, **exact symbol retrieval**, **vector search**, and **hybrid Retrieval-Augmented Generation (RAG)** to provide context-aware reviews and answers grounded in the actual codebase.

---

## 📖 Table of Contents

- [CodePilot: AI Codebase Intelligence \& Review Platform](#codepilot-ai-codebase-intelligence--review-platform)
  - [📖 Table of Contents](#-table-of-contents)
  - [🚀 Key Features](#-key-features)
  - [🏗️ System Architecture](#️-system-architecture)
  - [🧠 How Repository Intelligence Works](#-how-repository-intelligence-works)
    - [1. Repository Indexing](#1-repository-indexing)
      - [Generation Outside the Transaction](#generation-outside-the-transaction)
      - [Atomic Persistence](#atomic-persistence)
  - [🧩 Hierarchical Summarization](#-hierarchical-summarization)
  - [🔍 Hybrid Retrieval Pipeline](#-hybrid-retrieval-pipeline)
    - [Retrieval Stages Overview](#retrieval-stages-overview)
  - [🕸️ Structural Repository Graph](#️-structural-repository-graph)
  - [⚡ Incremental Delta Indexing](#-incremental-delta-indexing)
  - [🛠️ Technology Stack](#️-technology-stack)
  - [📂 Project Structure](#-project-structure)
  - [🚀 Getting Started](#-getting-started)
    - [Prerequisites](#prerequisites)
    - [1. Database Setup](#1-database-setup)
    - [2. Environment Variables](#2-environment-variables)
    - [3. Tree-sitter Parsers](#3-tree-sitter-parsers)
    - [4. Run the Platform](#4-run-the-platform)
  - [🗺️ Roadmap](#️-roadmap)
    - [Planned](#planned)
  - [🎯 Design Principles](#-design-principles)

---

## 🚀 Key Features

- **Automated AI-Powered Pull Request Reviews**  
  Analyzes code changes with repository-aware context to identify potential bugs, performance issues, maintainability concerns, and security problems.

- **Repository-Wide Codebase Q&A**  
  Ask natural language questions about a repository and retrieve relevant code, module summaries, and architectural context.

- **AST-Aware Code Chunking**  
  Uses Tree-sitter to split source files into syntax-aware units such as functions, classes, methods, and interfaces instead of arbitrary text chunks.

- **Hierarchical Repository Summarization**  
  Builds structured knowledge across multiple levels: Repository ➔ Architecture ➔ Components ➔ Files ➔ Code Chunks.

- **Feature-Oriented Module Discovery**  
  Groups files into logical domain modules rather than simply mirroring technical folder structures such as `controllers/`, `services/`, and `routes/`.

- **Structural Repository Graph**  
  Indexes deterministic cross-file import relationships and enables bounded structural traversal during retrieval.

- **Hybrid Retrieval Engine**  
  Combines exact symbol-definition lookup, structural dependency retrieval, related test discovery, dense vector search, and hierarchical semantic summaries.

- **Changed Symbol Analysis**  
  Maps PR changes back to the functions, classes, and symbols affected by the diff.

- **Candidate Merging and Provenance-Based Reranking**  
  Combines context retrieved from multiple strategies, removes duplicates, preserves retrieval provenance, and prioritizes the strongest evidence.

- **Token-Aware Context Budgeting**  
  Builds the final LLM context under a controlled token budget while reserving priority for the most relevant code.

- **Incremental Delta Indexing & Transactional Updates**  
  Uses Git-based change detection to avoid re-indexing an entire repository unnecessarily and safeguards data integrity via atomic database updates.

---

## 🏗️ System Architecture

```mermaid
flowchart TB
    subgraph Frontend
        UI["React Dashboard & Diff Viewer"]
    end

    subgraph Backend ["Express.js Backend"]
        Auth["Clerk Auth & GitHub API"]
        
        subgraph Core ["Services"]
            direction TB
            IDX["Indexing & Graph<br/>• Tree-sitter AST<br/>• Module Discovery<br/>• Summary Pipeline"]
            RET["Retrieval Engine<br/>• Semantic Search<br/>• Symbol & Graph Retrieval<br/>• Reranker & Context Budget"]
            REV["Review Services<br/>• PR Analysis<br/>• Impact Analysis<br/>• Test Discovery"]
        end
        
        LLM["LLM Interface<br/>Gemini / OpenRouter / Groq"]
    end
    
    DB[("PostgreSQL + pgvector<br/>Repository Graph")]

    UI <-->|"HTTP / REST / SSE"| Backend
    Auth --> Core
    Core --> LLM
    Core <--> DB
```

---

## 🧠 How Repository Intelligence Works

### 1. Repository Indexing

When a repository branch is synchronized, CodePilot builds both a semantic representation and a structural representation of the codebase.

The indexing pipeline follows:

```mermaid
flowchart TD
    A["Repository Sync"] --> B["Git Change Detection"]
    B --> C["Consistency Snapshot"]
    
    subgraph Generation ["Off-Transaction Processing"]
        D["AST Parsing & Chunking"]
        E["Import Resolution"]
        F["Embedding Generation"]
        G["Hierarchical Summary Generation"]
        H["Relationship Generation"]
    end
    
    C --> D
    D --> E --> F --> G --> H
    
    H --> I["In-Memory Transaction Buffer"]
    
    subgraph Atomic ["Database Transaction"]
        J["Verify Snapshot Consistency"]
        K["Delete Stale Data"]
        L["Insert New Data"]
    end
    
    I --> J
    J --> K --> L
    L --> M(("Commit"))
```

#### Generation Outside the Transaction

Potentially slow operations happen before a PostgreSQL transaction begins (AST analysis, Chunking, Embeddings, Summarization, Relationships). This prevents database transactions from remaining open while waiting for external LLM APIs.

#### Atomic Persistence

After generation completes, the system verifies the repository snapshot is unchanged, deletes stale entries, and inserts new ones within a short-lived transaction. If the repository state changed during generation, the transaction is rolled back.

---

## 🧩 Hierarchical Summarization

Large repositories cannot be passed directly into an LLM context window. CodePilot creates a hierarchical representation:

```mermaid
flowchart TD
    A["Repository Summary"] --> B["Architecture Summary"]
    B --> C["Component / Module Summaries"]
    C --> D["File Summaries"]
    D --> E["AST Code Chunks"]
    
    style A fill:#2e026d,stroke:#fff,stroke-width:2px,color:#fff
    style B fill:#4a148c,stroke:#fff,stroke-width:2px,color:#fff
    style C fill:#7b1fa2,stroke:#fff,stroke-width:2px,color:#fff
    style D fill:#9c27b0,stroke:#fff,stroke-width:2px,color:#fff
    style E fill:#ba68c8,stroke:#fff,stroke-width:2px,color:#fff
```

- **Repository Level**: Overall purpose, features, tech stack, high-level design.
- **Architecture Level**: Architecture style, major layers, system/data flows.
- **Component Level**: Logical domains (e.g., Authentication, Payments).
- **File Level**: File purpose, responsibilities, important classes/functions.
- **Code Level**: Syntax-aware AST chunks with symbol types, vectors, and ranges.

---

## 🔍 Hybrid Retrieval Pipeline

Code retrieval requires more than semantic similarity. For PR reviews, CodePilot uses a multi-stage retrieval pipeline:

```mermaid
flowchart TD
    A["Changed Code"] --> B["Changed Symbol Analysis"]
    B --> C["Exact Symbol Retrieval"]
    C --> D["1-Hop Structural Expansion"]
    D --> E["Related Test Discovery"]
    E --> F["Global Semantic Retrieval"]
    F --> G["Candidate Merge & Deduplication"]
    G --> H["Provenance-Based Reranking"]
    H --> I["Greedy Context Budgeting"]
    I --> J["Final LLM Context"]
    J --> K(("AI Code Review"))
```

### Retrieval Stages Overview

1. **Changed Code Analysis**: Identifies changed symbols, classes, methods, and functions.
2. **Exact Symbol Retrieval**: Resolves relevant symbols to their authoritative indexed definitions.
3. **Structural Graph Expansion**: Bounded one-hop traversal to identify direct dependencies and dependents.
4. **Related Test Discovery**: Finds test files via structural relationships and naming conventions.
5. **Global Semantic Retrieval**: Discovers semantically related code lacking explicit structural relationships.
6. **Candidate Merging and Deduplication**: Merges results from all strategies while preserving provenance (e.g., `graph_dependency`, `semantic`).
7. **Provenance-Based Reranking**: Prioritizes candidates based on retrieval strength (Exact Match > Structural > Test > Semantic).
8. **Context Budgeting**: A greedy allocator that reserves space for high-priority candidates first.

---

## 🕸️ Structural Repository Graph

The repository graph represents deterministic structural relationships (currently via `IMPORTS` and `RELATED_COMPONENT`).

Hierarchical ownership remains represented separately through a `parent_key` to avoid duplicating hierarchy inside the relationship graph.

```text
repository_relationships
        │
        └── IMPORTS
             File ──────► File
```

The current review pipeline performs bounded one-hop traversal, while the schema can support future bounded multi-hop strategies.

---

## ⚡ Incremental Delta Indexing

Re-indexing an entire repository after every change is expensive. CodePilot detects added, modified, and deleted files.

Only affected parts of the index are regenerated. The hierarchical summary pipeline propagates updates upward only when necessary.

---

## 🛠️ Technology Stack

| Domain | Technologies |
|---|---|
| **Backend** | Node.js, TypeScript, Express.js |
| **Database** | PostgreSQL, pgvector |
| **AI / NLP** | Tree-sitter (WebAssembly), Multi-provider LLM abstraction (Gemini, etc.) |
| **Frontend** | React, TypeScript, Vite, Tailwind CSS, TanStack React Query, Lucide React, Clerk Auth |
| **Infrastructure** | Docker, Git Webhooks |

---

## 📂 Project Structure

```text
backend/src/
├── services/
│   ├── Indexing & Summarization
│   │   ├── astChunking.service.ts
│   │   ├── moduleDiscovery.service.ts
│   │   └── summaryPipeline.service.ts
│   ├── Graph & Relationships
│   │   └── repositoryGraph.service.ts
│   ├── Retrieval
│   │   ├── semanticRetrieval.service.ts
│   │   ├── candidateMerger.service.ts
│   │   └── contextBudget.service.ts
│   └── Code Review & Impact Analysis
│       ├── review.service.ts
│       └── relatedTestDiscovery.service.ts
├── utils/
│   └── transactionBuffer.ts
├── types/
└── db/
    └── schema.sql
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- Docker Desktop (for PostgreSQL)
- Clerk account
- LLM API key

### 1. Database Setup

```bash
cd backend
docker-compose up -d
```

Enable pgvector and initialize the schema:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. Environment Variables

**`backend/.env`**
```env
PORT=5000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_code_review
CLERK_SECRET_KEY=your_clerk_secret_key
GEMINI_API_KEY=your_gemini_api_key
```

**`frontend/.env`**
```env
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
VITE_API_BASE_URL=http://localhost:5000/api
```

### 3. Tree-sitter Parsers

Place the required `.wasm` parser files inside `backend/parsers/` (e.g., `tree-sitter-typescript.wasm`).

### 4. Run the Platform

**Backend:**
```bash
cd backend
npm install
npm run dev
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

---

## 🗺️ Roadmap

- [x] AST-aware code chunking
- [x] Vector-based code retrieval
- [x] Feature-oriented module discovery
- [x] Hierarchical repository summarization
- [x] Incremental repository indexing
- [x] Structural relationship indexing
- [x] Exact symbol retrieval
- [x] Hybrid retrieval pipeline
- [x] Candidate merging and provenance tracking
- [x] Context reranking and budgeting
- [x] Changed symbol analysis
- [x] Related test discovery
- [x] Transaction-safe indexing with consistency guards

### Planned

- [ ] Server-Sent Events for streaming responses
- [ ] Inline AI discussion threads for review findings
- [ ] Multi-repository knowledge workspaces
- [ ] Cross-repository retrieval
- [ ] Additional AST relationship types such as `CALLS`
- [ ] Bounded multi-hop graph retrieval
- [ ] Retrieval quality evaluation benchmarks

---

## 🎯 Design Principles

CodePilot is designed around:

- **Separation of Concerns & SOLID Architecture**
- **Repository-Aware RAG**: Vector search alone is not enough for code intelligence.
- **AST-Based Code Understanding**
- **Deterministic + Semantic Retrieval**
- **Incremental Processing & Transactional Data Integrity**
- **Bounded Context Construction & Extensible LLM Provider Architecture**

> The central design principle is that **vector search alone is not enough for code intelligence**. CodePilot combines semantic similarity with the explicit structure of a repository to retrieve code that is not only relevant in meaning, but also relevant in how the code actually connects and behaves.
