

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS app_users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_id           TEXT NOT NULL UNIQUE,        -- Clerk's `user.id` — the join key to auth
    email              TEXT NOT NULL,
    name               TEXT,
    avatar_url         TEXT,
    github_connected   BOOLEAN NOT NULL DEFAULT FALSE,
    github_username    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_users_clerk_id ON app_users (clerk_id);


CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

    github_repo_id BIGINT NOT NULL,

    owner VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,

    description TEXT,
    language VARCHAR(100),

    is_private BOOLEAN NOT NULL,

    default_branch VARCHAR(100) NOT NULL,

    html_url TEXT NOT NULL,
    clone_url TEXT NOT NULL,

    last_pushed_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT repositories_user_repo_unique
        UNIQUE(user_id, github_repo_id)
);

CREATE INDEX IF NOT EXISTS repositories_user_idx
    ON repositories(user_id);

CREATE INDEX IF NOT EXISTS repositories_github_repo_idx
    ON repositories(github_repo_id);
--

CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,

    pull_number INTEGER NOT NULL,

    head_sha TEXT NOT NULL,

    model TEXT NOT NULL,

    status TEXT NOT NULL,

    summary TEXT,

    overall_score INTEGER,

    risk_level TEXT,

    raw_response JSONB NOT NULL,

    is_latest BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,

    severity TEXT NOT NULL,

    category TEXT NOT NULL,

    file_path TEXT NOT NULL,

    line_number INTEGER,

    title TEXT NOT NULL,

    description TEXT NOT NULL,

    recommendation TEXT NOT NULL,

    code_suggestion TEXT,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,

    role TEXT NOT NULL,

    content TEXT NOT NULL,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reviews_repo_pr_latest_idx ON reviews(repository_id, pull_number) WHERE is_latest = TRUE;
CREATE INDEX IF NOT EXISTS review_findings_review_id_idx ON review_findings(review_id);

-- 1. Enable the pgvector extension (Crucial first step)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the unified repository_embeddings table
CREATE TABLE repository_embeddings (
    -- Standard Identifiers
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL, -- Tracks the exact commit this chunk belongs to

    -- AST & Metadata specific fields (Crucial for Contextual Enrichment)
    file_path TEXT NOT NULL,
    language TEXT NOT NULL, -- e.g., 'TypeScript', 'Python'
    symbol_type TEXT NOT NULL, -- e.g., 'function', 'class', 'method', 'interface'
    symbol_name TEXT NOT NULL, -- e.g., 'AuthService', 'login'
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    
    -- The core RAG data
    content_hash TEXT NOT NULL, -- For exact matching during Orphan Cleanup / Delta updates
    content TEXT NOT NULL, -- The enriched raw string (e.g., File: X, Class: Y, Code...)
    embedding VECTOR(3072) NOT NULL, -- The standard dimension for current Gemini embedding models

    -- Auditing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure a chunk isn't duplicated for the exact same hash in the same repo
    UNIQUE(repository_id, file_path, content_hash)
);

-- 3. Create basic indexes for fast metadata lookups
-- (Used heavily during the Orphan Cleanup phase)
CREATE INDEX idx_repo_embeddings_repo_file ON repository_embeddings(repository_id, file_path);
CREATE INDEX idx_repo_embeddings_commit ON repository_embeddings(repository_id, commit_sha);

ALTER TABLE repositories 
ADD COLUMN last_indexed_sha VARCHAR(255);

-- Adds UI tracking state (unindexed, indexing, completed, failed)
ALTER TABLE repositories 
ADD COLUMN indexing_status VARCHAR(50) DEFAULT 'unindexed';

-- Enum for resumable workspace session types
CREATE TYPE workspace_session_type AS ENUM (
    'REVIEW_CHAT',
    'REPOSITORY_QA',
    'INTERVIEW'
);

-- Enum for discrete activity log events
CREATE TYPE log_activity_type AS ENUM (
    'REPOSITORY_IMPORTED',
    'REPOSITORY_INDEXED',
    'PR_REVIEW_STARTED',
    'PR_REVIEW_COMPLETED',
    'INTERVIEW_STARTED',
    'INTERVIEW_COMPLETED',
    'REPOSITORY_QA_STARTED'
);

CREATE TABLE workspace_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    session_id UUID NOT NULL, 
    session_type workspace_session_type NOT NULL,
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraint to enforce one active pointer per unique session, enabling clean UPSERTs
    CONSTRAINT uq_workspace_session UNIQUE (user_id, session_type, session_id)
);

-- Index to optimize fetching the most recent workspaces for a specific user's dashboard
CREATE INDEX idx_workspace_sessions_user_recent 
ON workspace_sessions(user_id, last_accessed_at DESC);

CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
    activity_type log_activity_type NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index to optimize fetching a global activity feed for a specific user
CREATE INDEX idx_activity_logs_user_date 
ON activity_logs(user_id, created_at DESC);

-- Index to optimize fetching a scoped activity feed for a specific repository view
CREATE INDEX idx_activity_logs_repo_date 
ON activity_logs(repository_id, created_at DESC);


-- One table for every summary level, per spec. Not flattened — summary_json
-- is stored exactly as the LLM returned it so it can become graph-node
-- properties later without a migration.
CREATE TABLE IF NOT EXISTS repository_summaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL,
  node_type     TEXT NOT NULL CHECK (node_type IN ('repository', 'architecture', 'component', 'file')),
  node_key      TEXT NOT NULL,       -- file path | module name | 'architecture' | 'repository'
  parent_key    TEXT,                -- NULL only for the repository row
  summary_json  JSONB NOT NULL,
  content_hash  TEXT NOT NULL,       -- addition beyond the spec's column list — Merkle-style hash
                                      -- used to skip regenerating nodes whose inputs haven't changed
  embedding     VECTOR(3072),        -- gemini-embedding-001 defaults to 3072 dims;
                                      -- log embedding.length once and confirm before running
                                      -- this migration, then adjust if you're requesting a
                                      -- truncated output_dimensionality
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (repository_id, node_type, node_key)
);

CREATE INDEX IF NOT EXISTS idx_repository_summaries_repo_type
  ON repository_summaries (repository_id, node_type);

CREATE INDEX IF NOT EXISTS idx_repository_summaries_parent
  ON repository_summaries (repository_id, parent_key);

-- NOT creating an HNSW/IVFFlat index on `embedding` here on purpose:
-- gemini-embedding-001's default 3072 dimensions exceed what pgvector's ANN
-- index types can index (practical cap is ~2000 dims). The column stores
-- 3072-dim vectors fine; queries just fall back to a sequential scan, which
-- is fine at the scale a first version runs at.
--
-- If/when you need an ANN index: request a truncated embedding via
-- `outputDimensionality` (1536 is the usual choice) in embedding.service.ts,
-- and manually normalize the result to unit length — gemini-embedding-001
-- does NOT auto-normalize truncated vectors (only gemini-embedding-2 does).
-- Then:
-- CREATE INDEX IF NOT EXISTS idx_repository_summaries_embedding
--   ON repository_summaries USING hnsw (embedding vector_cosine_ops);

-- Tracks the last commit a repo was fully indexed at. This is the
-- repo-level check the pipeline itself does NOT do: before calling
-- runSummarizationPipeline at all, compare the current HEAD sha to this
-- table and skip the whole run — no file parsing, no hashing, no per-file
-- DB reads — if nothing has changed since last time.

