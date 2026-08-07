
import { pool } from '../config/db.js';
import { WorkspaceSessionType, LogActivityType } from '../types/dashboardTypes.js';

/**
 * Call this whenever a user opens, creates, or resumes a workspace.
 * It inserts a new row OR bumps the last_accessed_at timestamp if it exists.
 */
export const touchWorkspaceSession = async (
  userId: string,
  repositoryId: string,
  sessionId: string,
  sessionType: WorkspaceSessionType
) => {
  const query = `
    INSERT INTO workspace_sessions (user_id, repository_id, session_id, session_type, last_accessed_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id, session_type, session_id)
    DO UPDATE SET last_accessed_at = NOW()
    RETURNING id;
  `;
  const { rows } = await pool.query(query, [userId, repositoryId, sessionId, sessionType]);
  return rows[0];
};

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