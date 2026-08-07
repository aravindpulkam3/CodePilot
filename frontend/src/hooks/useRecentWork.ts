import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/api/clientApi";

export interface RecentWork {
  id: string;
  repositoryName: string;
  activityType: "Review Chat" | "Interview Session" | "Ask Repository" | "Code Generation";
  timeAgo: string;
  url: string;
}

export const useRecentWork = () => {
  return useQuery({
    queryKey: ["recentWork"],
    queryFn: async () => {
      const { data } = await apiClient.get<RecentWork[]>("/dashboard/recent-work");
      return data;
    },
  });
};