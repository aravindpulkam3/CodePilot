/** PR files are mutable paginated data: accept them only between matching revisions. */
export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface PullRequestRevision {
  head: { sha: string };
  base: { sha: string };
  changed_files: number;
}

export async function fetchPullRequestSnapshot<T extends PullRequestRevision>(
  getMetadata: () => Promise<T>,
  getPage: (
    page: number,
  ) => Promise<{ files: PullRequestFile[]; hasNext: boolean }>,
): Promise<{ metadata: T; files: PullRequestFile[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await getMetadata();
    if (
      !before.head?.sha ||
      !before.base?.sha ||
      !Number.isInteger(before.changed_files) ||
      before.changed_files < 0
    ) {
      throw new Error("GITHUB_PR_FILES_INCOMPLETE");
    }
    // GitHub exposes at most 3,000 files on this endpoint. Do not review a prefix.
    if (before.changed_files > 3000) throw new Error("GITHUB_PR_FILE_LIMIT");
    const files = new Map<string, PullRequestFile>();
    let duplicate = false;
    let hasNext = false;
    for (let page = 1; page <= 30; page++) {
      // A failed page aborts immediately; revision retries are not network retries.
      const result = await getPage(page);
      if (
        !Array.isArray(result.files) ||
        result.files.some(
          (file) =>
            !file || typeof file.filename !== "string" || !file.filename,
        )
      ) {
        throw new Error("GITHUB_PR_FILES_INCOMPLETE");
      }
      for (const file of result.files) {
        if (!file.filename || files.has(file.filename)) duplicate = true;
        files.set(file.filename, file);
      }
      hasNext = result.hasNext;
      if (!hasNext) break;
    }
    const after = await getMetadata();
    if (
      before.head.sha !== after.head?.sha ||
      before.base.sha !== after.base?.sha
    ) {
      if (attempt === 0) continue;
      throw new Error("PR_REVISION_CHANGED");
    }
    if (
      duplicate ||
      hasNext ||
      files.size !== before.changed_files ||
      after.changed_files !== before.changed_files
    ) {
      throw new Error("GITHUB_PR_FILES_INCOMPLETE");
    }
    return { metadata: before, files: [...files.values()] };
  }
  throw new Error("PR_REVISION_CHANGED");
}
