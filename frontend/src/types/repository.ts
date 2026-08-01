export interface LocalRepository {
  id: string;
  user_id: string;
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
}

export interface PullRequestItem {
  number: number;
  title: string;
  state: "open" | "closed";
  merged_at: string | null;
  user: {
    login: string;
    avatar_url: string;
  };
  updated_at: string;
  created_at: string;
  html_url: string;
}

export interface ChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  description: string | null;
  state: string;
  merged: boolean;
  head_sha: string; // <-- ADD THIS LINE HERE
  author: {
    login: string;
    avatar_url: string;
  };
  additions: number;
  deletions: number;
  changed_files_count: number;
  commits_count: number;
  created_at: string;
  updated_at: string;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string;
  }>;
}