import { apiClient } from "@/services/api/clientApi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PullRequestReviews } from "@/types/reviewTypes";

// The POST /reviews response's findings have no `id` (only the GET
// endpoint's findings do — see PR Review redesign plan), so this response
// type is intentionally narrower than `Finding` and must not be used to
// drive "Ask AI"/finding-interaction UI. Callers should invalidate and
// read the refetched `usePullRequestReviews` data instead.
interface AIReviewResponse {
  reviewId: string;
  summary: string;
  overall_score: number;
  risk_level: string;
  findings: Array<{
    severity: string;
    category: string;
    file_path: string;
    line_number: number | null;
    title: string;
    description: string;
    recommendation: string;
    code_suggestion: string | null;
  }>;
}

export function useTriggerAiReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { repositoryId: string; pullNumber: number }) => {
      const { data } = await apiClient.post<AIReviewResponse>("/reviews", payload);
      return { ...data, ...payload };
    },
    onSuccess: (data) => {
      // The POST response's findings have no ids — refetch so "Ask AI"
      // works immediately on the newly generated review, and so the UI
      // shows it without a manual page refresh.
      queryClient.invalidateQueries({
        queryKey: ["reviews", data.repositoryId, String(data.pullNumber)],
      });
    },
  });
}

export function usePullRequestReviews(repositoryId: string, pullNumber: string) {
  return useQuery<PullRequestReviews>({
    queryKey: ["reviews", repositoryId, pullNumber],
    queryFn: async () => {
      const { data } = await apiClient.get<PullRequestReviews>(
        `/reviews/${repositoryId}/pulls/${pullNumber}`
      );
      return data;
    },
    enabled: !!repositoryId && !!pullNumber,
  });
}
