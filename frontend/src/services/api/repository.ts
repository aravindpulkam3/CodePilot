import {
  LocalRepository,
  PullRequestDetail,
  PullRequestItem,
} from "@/types/repository";
import { apiClient } from "./client";

export const getRepoDetails = async (
  repositoryId: string,
): Promise<LocalRepository> => {
  const { data } = await apiClient.get<LocalRepository>(
    `/repositories/${repositoryId}`,
  );
  return data;
};

export const getRepoPullRequests = async (
  repositoryId: string,
): Promise<PullRequestItem[]> => {
  const { data } = await apiClient.get<PullRequestItem[]>(
    `/repositories/${repositoryId}/pulls`,
  );
  return data;
};

export const getPullRequestDetails = async (
  repositoryId: string,
  pullNumber: string,
): Promise<PullRequestDetail> => {
  const { data } = await apiClient.get<PullRequestDetail>(
    `/repositories/${repositoryId}/pulls/${pullNumber}`,
  );
  return data;
};
