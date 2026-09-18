/**
 * Interface for GET /github/user
 * Represents the authenticated user's profile on GitHub.
 */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
}

/**
 * Interface for GET /github/repositories
 * Represents a single repository item returned in the list.
 *
 * Despite the name, this endpoint returns OUR OWN `repositories` DB row
 * shape (see backend/src/services/repository.service.ts#RepositoryRow),
 * not GitHub's raw API repo object — `id` is our internal UUID, `owner`
 * is a plain string, and several GitHub-only fields (stargazers, fork,
 * visibility, etc.) don't exist on it at all.
 */
/**
 * Indexing lifecycle: one deterministic phase (sync/parse/embed/import-graph).
 * READY means the index is complete for the latest synced revision. Only
 * READY/FAILED are terminal for polling purposes.
 */
export enum IndexingStatus {
  NOT_STARTED = 'NOT_STARTED',
  SYNCING = 'SYNCING',
  INDEXING = 'INDEXING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export type RepositorySourceType = "connected" | "public_import";

export interface GitHubRepository {
  id: string;
  user_id: string;
  source_type: RepositorySourceType;
  github_repo_id: number;
  name: string;
  owner: string;
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
  indexing_status?: IndexingStatus | null;
  // Workspace membership — orthogonal to indexing_status. Non-null means
  // the user explicitly clicked "Start Working on This Repo" (or imported
  // it by URL); it does NOT track whether a job is currently running.
  workspace_started_at?: string | null;
  searchable_at?: string | null;
}
