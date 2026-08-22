

-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CREATE TABLE IF NOT EXISTS app_users (
--     id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     clerk_id           TEXT NOT NULL UNIQUE,        -- Clerk's `user.id` — the join key to auth
--     email              TEXT NOT NULL,
--     name               TEXT,
--     avatar_url         TEXT,
--     github_connected   BOOLEAN NOT NULL DEFAULT FALSE,
--     github_username    TEXT,
--     created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
--     updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
-- );

-- CREATE INDEX IF NOT EXISTS idx_app_users_clerk_id ON app_users (clerk_id);


-- CREATE TABLE IF NOT EXISTS repositories (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

--     user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

--     github_repo_id BIGINT NOT NULL,

--     owner VARCHAR(255) NOT NULL,
--     name VARCHAR(255) NOT NULL,

--     description TEXT,
--     language VARCHAR(100),

--     is_private BOOLEAN NOT NULL,

--     default_branch VARCHAR(100) NOT NULL,

--     html_url TEXT NOT NULL,
--     clone_url TEXT NOT NULL,

--     last_pushed_at TIMESTAMPTZ,
--     last_synced_at TIMESTAMPTZ NOT NULL,

--     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

--     CONSTRAINT repositories_user_repo_unique
--         UNIQUE(user_id, github_repo_id)
-- );

-- CREATE INDEX IF NOT EXISTS repositories_user_idx
--     ON repositories(user_id);

-- CREATE INDEX IF NOT EXISTS repositories_github_repo_idx
--     ON repositories(github_repo_id);
-- --

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
CREATE INDEX IF NOT EXISTS reviews_repo_pr_latest_idx ON reviews(repository_id, pull_number) WHERE is_latest = TRUE;


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


-- CREATE TABLE IF NOT EXISTS review_messages (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

--     review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,

--     role TEXT NOT NULL,

--     content TEXT NOT NULL,

--     created_at TIMESTAMP DEFAULT NOW()
-- );

-- 1. Enable the pgvector extension (Crucial first step)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- -- 2. Create the unified repository_embeddings table
-- CREATE TABLE IF NOT EXISTS repository_embeddings (
--     -- Standard Identifiers
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
--     commit_sha TEXT NOT NULL, -- Tracks the exact commit this chunk belongs to

--     -- AST & Metadata specific fields (Crucial for Contextual Enrichment)
--     file_path TEXT NOT NULL,
--     language TEXT NOT NULL, -- e.g., 'TypeScript', 'Python'
--     symbol_type TEXT NOT NULL, -- e.g., 'function', 'class', 'method', 'interface'
--     symbol_name TEXT NOT NULL, -- e.g., 'AuthService', 'login'
--     start_line INTEGER NOT NULL,
--     end_line INTEGER NOT NULL,
    
--     -- The core RAG data
--     content_hash TEXT NOT NULL, -- For exact matching during Orphan Cleanup / Delta updates
--     content TEXT NOT NULL, -- The enriched raw string (e.g., File: X, Class: Y, Code...)
--     embedding VECTOR(3072) NOT NULL, -- The standard dimension for current Gemini embedding models

--     -- Auditing
--     created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
--     updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
--     -- Ensure a chunk isn't duplicated for the exact same hash in the same repo
--     UNIQUE(repository_id, file_path, content_hash)
-- );

-- -- 3. Create basic indexes for fast metadata lookups
-- -- (Used heavily during the Orphan Cleanup phase)
-- CREATE INDEX IF NOT EXISTS idx_repo_embeddings_repo_file ON repository_embeddings(repository_id, file_path);
-- CREATE INDEX IF NOT EXISTS idx_repo_embeddings_commit ON repository_embeddings(repository_id, commit_sha);

-- ALTER TABLE repositories 
-- ADD COLUMN last_indexed_sha VARCHAR(255);

-- -- Adds UI tracking state (unindexed, indexing, completed, failed)
-- ALTER TABLE repositories 
-- ADD COLUMN indexing_status VARCHAR(50) DEFAULT 'unindexed';

-- Enum for resumable workspace session types
-- DO $$
-- BEGIN
--     IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_session_type') THEN
--         CREATE TYPE workspace_session_type AS ENUM (
--             'REVIEW_CHAT',
--             'REPOSITORY_QA',
--             'INTERVIEW'
--         );
--     END IF;
-- END$$;

-- -- Enum for discrete activity log events
-- DO $$
-- BEGIN
--     IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'log_activity_type') THEN
--         CREATE TYPE log_activity_type AS ENUM (
--             'REPOSITORY_IMPORTED',
--             'REPOSITORY_INDEXED',
--             'PR_REVIEW_STARTED',
--             'PR_REVIEW_COMPLETED',
--             'INTERVIEW_STARTED',
--             'INTERVIEW_COMPLETED',
--             'REPOSITORY_QA_STARTED'
--         );
--     END IF;
-- END$$;

-- CREATE TABLE IF NOT EXISTS workspace_sessions (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
--     repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
--     session_id UUID NOT NULL, 
--     session_type workspace_session_type NOT NULL,
--     last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
--     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
--     -- Constraint to enforce one active pointer per unique session, enabling clean UPSERTs
--     CONSTRAINT uq_workspace_session UNIQUE (user_id, session_type, session_id)
-- );

-- -- Index to optimize fetching the most recent workspaces for a specific user's dashboard
-- CREATE INDEX IF NOT EXISTS idx_workspace_sessions_user_recent 
-- ON workspace_sessions(user_id, last_accessed_at DESC);

-- CREATE TABLE IF NOT EXISTS activity_logs (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
--     repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
--     activity_type log_activity_type NOT NULL,
--     metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
--     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
-- );

-- -- Index to optimize fetching a global activity feed for a specific user
-- CREATE INDEX IF NOT EXISTS idx_activity_logs_user_date 
-- ON activity_logs(user_id, created_at DESC);

-- -- Index to optimize fetching a scoped activity feed for a specific repository view
-- CREATE INDEX IF NOT EXISTS idx_activity_logs_repo_date 
-- ON activity_logs(repository_id, created_at DESC);


-- One table for every summary level, per spec. Not flattened — summary_json
-- is stored exactly as the LLM returned it so it can become graph-node
-- properties later without a migration.
-- CREATE TABLE IF NOT EXISTS repository_summaries (
--   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   repository_id UUID NOT NULL,
--   node_type     TEXT NOT NULL CHECK (node_type IN ('repository', 'architecture', 'component', 'file')),
--   node_key      TEXT NOT NULL,       -- file path | module name | 'architecture' | 'repository'
--   parent_key    TEXT,                -- NULL only for the repository row
--   summary_json  JSONB NOT NULL,
--   content_hash  TEXT NOT NULL,       -- addition beyond the spec's column list — Merkle-style hash
--                                       -- used to skip regenerating nodes whose inputs haven't changed
--   embedding     VECTOR(3072),        -- gemini-embedding-001 defaults to 3072 dims;
--                                       -- log embedding.length once and confirm before running
--                                       -- this migration, then adjust if you're requesting a
--                                       -- truncated output_dimensionality
--   created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
--   updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

--   UNIQUE (repository_id, node_type, node_key)
-- );

-- CREATE INDEX IF NOT EXISTS idx_repository_summaries_repo_type
--   ON repository_summaries (repository_id, node_type);

-- CREATE INDEX IF NOT EXISTS idx_repository_summaries_parent
--   ON repository_summaries (repository_id, parent_key);


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
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_chat_sessions_repo_user ON chat_sessions(repository_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_type ON chat_sessions(type);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_review ON chat_sessions(review_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_finding ON chat_sessions(finding_id);

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
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


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


