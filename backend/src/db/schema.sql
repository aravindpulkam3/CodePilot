

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

    source_type VARCHAR(50) NOT NULL DEFAULT 'connected',

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
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reviews_repo_pr_latest_idx ON reviews(repository_id, pull_number) WHERE is_latest = TRUE;
CREATE INDEX IF NOT EXISTS idx_reviews_last_accessed ON reviews(last_accessed_at DESC);


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
CREATE INDEX IF NOT EXISTS review_findings_review_id_idx ON review_findings(review_id);


CREATE TABLE IF NOT EXISTS review_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,

    role TEXT NOT NULL,

    content TEXT NOT NULL,

    created_at TIMESTAMP DEFAULT NOW()
);

-- 1. Enable the pgvector extension (Crucial first step)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the unified repository_embeddings table
CREATE TABLE IF NOT EXISTS repository_embeddings (
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

-- -- 3. Create basic indexes for fast metadata lookups
-- -- (Used heavily during the Orphan Cleanup phase)
CREATE INDEX IF NOT EXISTS idx_repo_embeddings_repo_file ON repository_embeddings(repository_id, file_path);
CREATE INDEX IF NOT EXISTS idx_repo_embeddings_commit ON repository_embeddings(repository_id, commit_sha);

-- IF NOT EXISTS on both: schema.sql is applied idempotently by db/migrate.ts,
-- so a bare ADD COLUMN aborts the entire file on the second run.
ALTER TABLE repositories
ADD COLUMN IF NOT EXISTS last_indexed_sha VARCHAR(255);

-- -- Adds UI tracking state (unindexed, indexing, completed, failed)
ALTER TABLE repositories
ADD COLUMN IF NOT EXISTS indexing_status VARCHAR(50) DEFAULT 'unindexed';



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

CREATE INDEX IF NOT EXISTS idx_repository_summaries_repo_type  ON repository_summaries (repository_id, node_type);

CREATE INDEX IF NOT EXISTS idx_repository_summaries_parent ON repository_summaries (repository_id, parent_key);


CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- User who owns this chat session
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    
    -- Session Type: 'REPO_QA' | 'REVIEW_CHAT' | 'ISSUE_CHAT' | 'INTERVIEW'
    type VARCHAR(50) NOT NULL DEFAULT 'REPO_QA',
    
    -- Scoped Relationships (Nullable depending on session type)
    repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    finding_id UUID REFERENCES review_findings(id) ON DELETE CASCADE,
    
    -- Human-readable label (e.g., "Discussion: O(n^2) loop")
    title VARCHAR(255),
    
    -- Status: 'active' | 'completed' | 'archived'
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    
    -- Extensible metadata / state payload
    state JSONB DEFAULT '{}'::jsonb,
    
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_chat_sessions_repo_user ON chat_sessions(repository_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_type ON chat_sessions(type);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_review ON chat_sessions(review_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_finding ON chat_sessions(finding_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_recent ON chat_sessions(user_id, last_accessed_at DESC);

-- Enforce EXACTLY ONE Issue Chat session per review finding per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_finding_user 
ON chat_sessions (finding_id, user_id) 
WHERE type = 'ISSUE_CHAT' AND finding_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS interview_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- 1-to-1 link to chat_sessions
    session_id UUID NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
    
    -- Ownership links
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    
    -- Interview domain state
    current_topic TEXT NOT NULL DEFAULT 'System Architecture',
    topics_covered TEXT[] DEFAULT '{}',
    current_difficulty VARCHAR(20) NOT NULL DEFAULT 'medium',
    question_count INTEGER NOT NULL DEFAULT 0,
    overall_score NUMERIC(4, 2),
    assessment JSONB,
    
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_interview_sessions_user_recent ON interview_sessions(user_id, last_accessed_at DESC);


CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Links to parent chat session
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    
    -- Role: 'user' | 'assistant' | 'system'
    role VARCHAR(50) NOT NULL,
    
    -- Raw message content (Markdown supported)
    content TEXT NOT NULL,
    
    -- Structured metadata (e.g., sources, citations, tokens, latency)
    metadata JSONB DEFAULT '{}'::jsonb,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Chronological index for fast message history retrieval
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
    activity_type VARCHAR(100) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_recent ON activity_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_repository_recent ON activity_logs(repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repository_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,

    source_node_type TEXT NOT NULL,
    source_node_key TEXT NOT NULL,
    target_node_type TEXT NOT NULL,
    target_node_key TEXT NOT NULL,

    relationship_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (repository_id, source_node_type, source_node_key, target_node_type, target_node_key, relationship_type),
    CONSTRAINT relationship_type_valid CHECK (relationship_type IN ('IMPORTS', 'RELATED_COMPONENT'))
);

CREATE INDEX IF NOT EXISTS idx_repo_rels_src ON repository_relationships (repository_id, source_node_key);
CREATE INDEX IF NOT EXISTS idx_repo_rels_tgt ON repository_relationships (repository_id, target_node_key);

-- Phased indexing (SEARCHABLE -> READY) + "Currently Working On" workspace
-- membership. All additive and idempotent, unlike the two bare ADD COLUMN
-- statements above (last_indexed_sha / indexing_status) — those predate
-- this convention and are left as-is since re-running them is harmless once
-- already applied, but new columns from here on always use IF NOT EXISTS
-- so this file stays safe to re-run in full, matching db/migrate.ts's model.

-- searchable_at: Phase 1 (sync/parse/embed/import-graph) completion marker.
-- last_summarized_sha: how far Phase 2 (LLM summarization) has caught up.
-- READY means indexing_status = 'READY', written only when last_indexed_sha
-- and last_summarized_sha are both non-null and equal, and searchable_at is
-- set — see retreival.service.ts / repositorySummarize.service.ts.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS searchable_at        TIMESTAMPTZ NULL;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_summarized_sha  VARCHAR(255) NULL;

-- "Currently Working On": NULL = not an active workspace member (just
-- listed from GitHub); non-null = when the user clicked "Start Working",
-- also used as the dashboard section's sort order. Orthogonal to
-- indexing_status — see CLAUDE.md's workspace-vs-indexing-status note.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS workspace_started_at TIMESTAMPTZ NULL;

-- Phase 1 progress (chunk/file counts), Phase 2 progress (summary task
-- count) — informational only, never used to gate readiness.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS index_chunks_total   INTEGER;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS index_chunks_done    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS index_files_total    INTEGER;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS index_files_done     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS summary_tasks_total  INTEGER;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS summary_tasks_done   INTEGER NOT NULL DEFAULT 0;

-- Non-blocking summary-failure signal. Set only when a summarize job
-- exhausts its retries; cleared at the start of the next attempt. Never
-- affects indexing_status/searchable_at — a repo stays fully usable for
-- Q&A/Review even while this is set.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_summary_error   TEXT NULL;

-- One-time backfill for the old three-value indexing_status vocabulary
-- ('unindexed' | 'INDEXING' | 'INDEXED' | 'FAILED') into the new one
-- (NOT_STARTED | SYNCING | INDEXING | SEARCHABLE | SUMMARIZING | READY |
-- FAILED). Each UPDATE is naturally idempotent (a second run finds no rows
-- still in the old state to touch), consistent with this file's
-- re-run-safe model.
UPDATE repositories SET indexing_status = 'NOT_STARTED'
  WHERE indexing_status = 'unindexed' OR indexing_status IS NULL;
UPDATE repositories SET indexing_status = 'READY',
       searchable_at = COALESCE(searchable_at, updated_at),
       last_summarized_sha = last_indexed_sha
  WHERE indexing_status = 'INDEXED';
UPDATE repositories SET indexing_status = 'SYNCING'
  WHERE indexing_status = 'INDEXING' AND searchable_at IS NULL;
-- Rows already 'FAILED' are left as-is — see CLAUDE.md for the one-time
-- backfill imprecision this implies (harmless, resolves on next sync).
CREATE INDEX IF NOT EXISTS idx_repo_rels_type ON repository_relationships (repository_id, relationship_type);
