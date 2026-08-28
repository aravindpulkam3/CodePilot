import { apiClient } from "./clientApi";
import type { AppUser } from "@/types/user";

/**
 * Placeholder endpoint calls for the application-user resource. The
 * backend routes exist (see backend/src/routes/user.routes.ts) but return
 * minimal data for now — this file is the seam future features build on.
 */
export const usersApi = {
  getMe: async (): Promise<AppUser> => {
    console.log("came to userAPI service");
    const { data } = await apiClient.get<AppUser>("/users/me");
    return data;
  },
};
