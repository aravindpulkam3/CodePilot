import { pool } from "../config/db.js";

export interface ActivityLogParams {
  userId: string;
  repositoryId?: string | null;
  activityType: string;
  metadata?: Record<string, any>;
}

export class ActivityLogService {
  /**
   * Logs a significant event to the activity_logs table.
   */
  async logEvent(params: ActivityLogParams): Promise<void> {
    const { userId, repositoryId, activityType, metadata = {} } = params;
    
    try {
      const query = `
        INSERT INTO activity_logs (user_id, repository_id, activity_type, metadata)
        VALUES ($1, $2, $3, $4)
      `;
      const values = [userId, repositoryId || null, activityType, JSON.stringify(metadata)];
      
      await pool.query(query, values);
    } catch (error) {
      console.error("Failed to log activity:", error);
      // We purposefully don't throw here to avoid failing the main business operation 
      // if logging fails.
    }
  }
}

export const activityLogService = new ActivityLogService();
