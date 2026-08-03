

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

Adds the memory pointer for Delta Indexing
ALTER TABLE repositories 
ADD COLUMN last_indexed_sha VARCHAR(255);

-- Adds UI tracking state (unindexed, indexing, completed, failed)
ALTER TABLE repositories 
ADD COLUMN indexing_status VARCHAR(50) DEFAULT 'unindexed';