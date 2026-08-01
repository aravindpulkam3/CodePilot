-- AI Engineering Workspace — initial schema
-- Authentication itself is handled entirely by Clerk (identity, sessions,
-- passwords, OAuth). This database never stores credentials. `app_users`
-- holds only application-specific data, keyed to Clerk's user id.

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

-- CREATE TABLE documentation_pages (
--     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
--     title          TEXT NOT NULL,
--     content        TEXT NOT NULL,
--     generated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
-- );
