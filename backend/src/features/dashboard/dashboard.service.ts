
import { pool } from '../../config/db.js';
import { LogActivityType } from './dashboardTypes.js';

/**
 * Call this to record a permanent audit log event.
 */
export const logActivity = async (
  userId: string,
  repositoryId: string | null,
  activityType: LogActivityType,
  metadata: Record<string, any> = {}
) => {
  const query = `
    INSERT INTO activity_logs (user_id, repository_id, activity_type, metadata)
    VALUES ($1, $2, $3, $4)
  `;
  await pool.query(query, [userId, repositoryId, activityType, JSON.stringify(metadata)]);
};