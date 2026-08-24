import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/api/clientApi";

export interface RecentActivity {
  id: string;
  type: string;
  metadata: Record<string, any>;
  repositoryName?: string;
  timeAgo: string;
  createdAt: string;
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