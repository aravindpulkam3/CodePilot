import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/api/clientApi";

export interface RecentWork {
  id: string;
  type: string;
  repositoryId: string;
  repositoryName: string;
  title: string;
  timeAgo: string;
  route: string;
  lastAccessedAt: string;
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