import { pool } from '../config/db.js'; // Adjust path to where pool is exported

export interface UpsertRepoInput {
  userId: string; // Internal app_users UUID
  sourceType?: string; // 'connected' | 'public_import'
  githubRepoId: number;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  lastPushedAt: string | null;
}

export interface RepositoryRow {
  id: string;
  user_id: string;
  source_type: string;
  github_repo_id: number;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  is_private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  last_pushed_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Upserts a batch of GitHub repositories into PostgreSQL for a given user using pg Pool.
 */
export const upsertRepositories = async (userId: string, repos: UpsertRepoInput[]) => {
  if (repos.length === 0) return [];

  const now = new Date();

  const queryText = `
    INSERT INTO repositories (
      user_id,
      source_type,
      github_repo_id,
      owner,
      name,
      description,
      language,
      is_private,
      default_branch,
      html_url,
      clone_url,
      last_pushed_at,
      last_synced_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
    ON CONFLICT (user_id, github_repo_id)
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      owner = EXCLUDED.owner,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      language = EXCLUDED.language,
      is_private = EXCLUDED.is_private,
      default_branch = EXCLUDED.default_branch,
      html_url = EXCLUDED.html_url,
      clone_url = EXCLUDED.clone_url,
      last_pushed_at = EXCLUDED.last_pushed_at,
      last_synced_at = EXCLUDED.last_synced_at,
      updated_at = NOW()
      RETURNING *, (xmax = 0) AS is_new_record;
  `;

  // Run the upserts concurrently through the pg pool
  const upsertPromises = repos.map((repo) => {
    const values = [
      userId,
      repo.sourceType || 'connected',
      repo.githubRepoId,
      repo.owner,
      repo.name,
      repo.description,
      repo.language,
      repo.isPrivate,
      repo.defaultBranch,
      repo.htmlUrl,
      repo.cloneUrl,
      repo.lastPushedAt,
      now,
    ];

    return pool.query(queryText, values);
  });

  const results = await Promise.all(upsertPromises);
  
  // Extract and return the updated/inserted rows
  return results.map((res) => res.rows[0]);
};

export const findRepositoryById = async (id: string): Promise<RepositoryRow | null> => {
  const { rows } = await pool.query<RepositoryRow>(
    `SELECT * FROM repositories WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
};

export const findRepositoriesByUserId = async (userId: string): Promise<RepositoryRow[]> => {
  const { rows } = await pool.query<RepositoryRow>(
    `SELECT * FROM repositories WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  );
  return rows;
};

/**
 * Creates or updates a public repository record.
 */
export const createPublicRepository = async (userId: string, repo: UpsertRepoInput): Promise<RepositoryRow> => {
  const results = await upsertRepositories(userId, [
    { ...repo, sourceType: 'public_import' }
  ]);
  return results[0];
};

