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
 */
export enum IndexingStatus {
  UNINDEXED = 'UNINDEXED',
  PENDING = 'PENDING',
  INDEXING = 'INDEXING',   // Currently processing
  INDEXED = 'INDEXED',     // Success
  FAILED = 'FAILED'
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  language: string | null;
  default_branch: string;
  updated_at: string;
  created_at: string;
  pushed_at: string;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  open_issues_count: number;
  visibility: "public" | "private" | "internal";
  owner: {
    login: string;
    avatar_url: string;
    html_url: string;
  };
  indexing_status?: IndexingStatus;
}
