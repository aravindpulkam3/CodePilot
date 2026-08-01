

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

CREATE TABLE reviews (
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
