-- CodePilot database schema: the complete current definition for a fresh database.
--
-- Applied as a whole by db/migrate.ts. Every statement is IF NOT EXISTS, so
-- re-running it is a no-op. This file is not a migration history: to change a
-- table, edit its CREATE TABLE here and reset the local database.

CREATE EXTENSION IF NOT EXISTS vector;


-- ─── Users ──────────────────────────────────────────────────────────────────

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


-- ─── Repositories and their index ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

    -- GitHub identity and metadata, refreshed whenever the repo list syncs.
    source_type VARCHAR(50) NOT NULL DEFAULT 'connected',  -- 'connected' | 'public_import'
    github_repo_id BIGINT NOT NULL,
    owner VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    language VARCHAR(100),
    is_private BOOLEAN NOT NULL,
    default_branch VARCHAR(100) NOT NULL,
    html_url TEXT NOT NULL,
    last_pushed_at TIMESTAMPTZ,

    -- "Currently Working On" membership: NULL = only listed; set by
    -- start-working. Independent of indexing_status.
    workspace_started_at TIMESTAMPTZ,

    -- Index state. last_indexed_sha is the commit the index reflects; NULL
    -- means never indexed or invalidated (a run failed after enqueuing chunks,
    -- so rows may be mixed), and retrieval refuses to run until it is set.
    indexing_status VARCHAR(50) NOT NULL DEFAULT 'NOT_STARTED',  -- NOT_STARTED | INDEXING | READY | FAILED
    last_indexed_sha VARCHAR(255),

    -- The current (or last) indexing run. indexing_run_id is the owning sync
    -- job's id and fences out jobs from superseded runs; indexing_target_sha
    -- pins the commit so a retried sync rebuilds the same chunk list;
    -- index_chunks_total is NULL until chunk jobs are enqueued; each chunk job
    -- appends its index to completed_index_chunks in the same transaction as
    -- its writes, which makes completion idempotent under job retries.
    indexing_run_id TEXT,
    indexing_target_sha TEXT,
    index_chunks_total INTEGER,
    completed_index_chunks INTEGER[] NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT repositories_user_repo_unique UNIQUE (user_id, github_repo_id)
);


-- One row per chunk: an AST symbol of a code file, a section of a prose doc,
-- or a whole config file (symbol_type = 'documentation' for docs and config).
-- There is no ANN index: pgvector index types cap at 2000 dimensions, so every
-- similarity search is a sequential scan over the repository's rows.
CREATE TABLE IF NOT EXISTS repository_embeddings (
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,       -- unchanged chunks are kept, not re-embedded
    commit_sha TEXT NOT NULL,         -- revision this chunk was indexed at

    symbol_type TEXT NOT NULL,        -- 'function' | 'class' | 'method' | 'class_skeleton' | 'documentation' | ...
    symbol_name TEXT NOT NULL,
    qualified_name TEXT,              -- e.g. 'UserService.createUser'
    parent_symbol TEXT,               -- enclosing class/interface, if any
    is_exported BOOLEAN,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    -- Set only on the parts of a split symbol or document. chunk_total IS NULL
    -- marks a whole row, which is how byte-exact config files are recognised.
    chunk_index INTEGER,
    chunk_total INTEGER,

    content TEXT NOT NULL,            -- the embedded text: chunk header + source
    embedding VECTOR(3072) NOT NULL,

    PRIMARY KEY (repository_id, file_path, content_hash)
);


-- File-level import graph. A resolved row's target is the imported file's
-- path. An unresolved row keeps the raw relative specifier (its target file
-- may sit in a later index chunk) and is re-resolved when a run finalizes.
-- Graph reads must filter on `resolved`, or a specifier surfaces as a file.
CREATE TABLE IF NOT EXISTS repository_imports (
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    target TEXT NOT NULL,
    resolved BOOLEAN NOT NULL,

    PRIMARY KEY (repository_id, source_path, target, resolved)
);

-- Reverse lookups: dependents of a file, import fan-in, rename retargeting.
CREATE INDEX IF NOT EXISTS idx_repository_imports_target
    ON repository_imports (repository_id, target) WHERE resolved;


-- ─── Pull request reviews ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    model TEXT NOT NULL,              -- LLM that produced the review
    summary TEXT,
    overall_score INTEGER,
    risk_level TEXT,
    raw_response JSONB NOT NULL,      -- the model's full structured output
    is_latest BOOLEAN DEFAULT TRUE,
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_repo_pr ON reviews (repository_id, pull_number);


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
    code_suggestion TEXT
);

CREATE INDEX IF NOT EXISTS review_findings_review_id_idx ON review_findings (review_id);


-- ─── Chat and interview sessions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

    type VARCHAR(50) NOT NULL DEFAULT 'REPO_QA',  -- 'REPO_QA' | 'REVIEW_CHAT' | 'ISSUE_CHAT' | 'INTERVIEW'

    -- Scope; which of these is set depends on the session type.
    repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    finding_id UUID REFERENCES review_findings(id) ON DELETE CASCADE,

    title VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'active',  -- 'active' | 'completed' (interviews)

    -- Interview state (focus, coverage, difficulty, ...); '{}' for other types.
    state JSONB DEFAULT '{}'::jsonb,

    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_repo_user ON chat_sessions (repository_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_recent ON chat_sessions (user_id, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_review ON chat_sessions (review_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_finding ON chat_sessions (finding_id);

-- Exactly one issue chat per review finding per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_finding_user
    ON chat_sessions (finding_id, user_id)
    WHERE type = 'ISSUE_CHAT' AND finding_id IS NOT NULL;

-- Exactly one PR-level review chat per review per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_review_user
    ON chat_sessions (review_id, user_id)
    WHERE type = 'REVIEW_CHAT' AND review_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,            -- Markdown
    -- Per-message structured data, e.g. Q&A prompt provenance (promptContext)
    -- and interview turn evaluations.
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at ASC);


-- ─── Activity feed ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
    activity_type VARCHAR(100) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_recent ON activity_logs (user_id, created_at DESC);
