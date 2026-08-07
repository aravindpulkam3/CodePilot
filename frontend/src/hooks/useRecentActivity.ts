import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/api/clientApi";

export interface RecentActivity {
  id: string;
  description: string;
  timeAgo: string;
  type: "pr_review" | "index_success" | "index_failed" | "chat" | "interview";
}

export const useRecentActivity = () => {
  return useQuery({
    queryKey: ["recentActivity"],
    queryFn: async () => {
      const { data } = await apiClient.get<RecentActivity[]>("/dashboard/activity");
      return data;
    },
  });
};