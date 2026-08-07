import { apiClient } from "@/services/api/clientApi";
import { useMutation, useQuery } from "@tanstack/react-query";

// Optional: You can import the interface from your backend or define it here
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
  return useMutation({
    mutationFn: async (payload: { repositoryId: string; pullNumber: number }) => {
      const { data } = await apiClient.post<AIReviewResponse>("/reviews", payload);
      return data;
    },
  });
}

export interface ReviewHistoryItem {
  id: string;
  summary: string;
  overall_score: number;
  created_at: string;
}

export function usePullRequestReviews(repositoryId: string, pullNumber: string) {
  return useQuery({
    queryKey: ["reviews", repositoryId, pullNumber],
    queryFn: async () => {
      const { data } = await apiClient.get(
        `/reviews/${repositoryId}/pulls/${pullNumber}`
      );
      return data;
    },
    enabled: !!repositoryId && !!pullNumber,
  });
}