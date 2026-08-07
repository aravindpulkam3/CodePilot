import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/api/clientApi";

export interface PendingPR {
  id: number;
  number: number;
  title: string;
  repositoryName: string;
  author: string;
  authorAvatarUrl: string;
  timeAgo: string;
  status: "open" | "draft" | "needs_review";
}

export const usePendingPRs = () => {
  return useQuery({
    queryKey: ["pendingPRs"],
    queryFn: async () => {
      const { data } = await apiClient.get<PendingPR[]>("/dashboard/pending-prs");
      return data;
    },
  });
};