import axios from "axios";

/**
 * True when the backend refused a request because the user hasn't linked
 * GitHub. That's an expected account state, not a failure: screens render
 * it inline ("Connect GitHub to …") instead of toasting, and it's never
 * retried since a retry can't change the answer.
 */
export function isGitHubNotConnected(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.data?.code === "GITHUB_NOT_CONNECTED"
  );
}
