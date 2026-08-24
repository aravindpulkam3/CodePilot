import { Response,Request } from "express";
import { pool } from "../config/db.js"; // Your pg pool
import axios from "axios";
import { getGitHubAccessToken } from "../services/github.service.js"; // Your token fetcher


/**
 * 1. Get Recent Work
 * Fetches recent chat sessions, PR reviews, or interviews the user interacted with.
 */
export const getRecentWork = async (req: Request, res: Response) => {
  try {
    const userId = req.dbUser!.id;

    const query = `
      SELECT 
        r.id, 
        'REVIEW' as type, 
        r.repository_id as "repositoryId", 
        repo.name as "repositoryName",
        'PR #' || r.pull_number as title, 
        r.last_accessed_at as "lastAccessedAt",
        '/repositories/' || r.repository_id || '/pulls/' || r.pull_number as route
      FROM reviews r
      JOIN repositories repo ON r.repository_id = repo.id
      WHERE repo.user_id = $1 
        AND r.is_latest = TRUE

      UNION ALL

      SELECT 
        c.id, 
        c.type, 
        c.repository_id as "repositoryId", 
        repo.name as "repositoryName",
        c.title, 
        c.last_accessed_at as "lastAccessedAt",
        CASE 
          WHEN c.type = 'INTERVIEW' THEN '/repositories/' || c.repository_id || '/interview/' || c.id
          WHEN c.type = 'REPO_QA' THEN '/repositories/' || c.repository_id || '?tab=chat'
          ELSE '/repositories/' || c.repository_id
        END as route
      FROM chat_sessions c
      LEFT JOIN repositories repo ON c.repository_id = repo.id
      WHERE c.user_id = $1

      ORDER BY "lastAccessedAt" DESC NULLS LAST
      LIMIT 5;
    `;
    const { rows } = await pool.query(query, [userId]);

    const formattedWork = rows.map(row => ({
      id: row.id,
      type: row.type,
      repositoryId: row.repositoryId,
      repositoryName: row.repositoryName || "Unknown",
      title: row.title,
      timeAgo: calculateTimeAgo(row.lastAccessedAt),
      route: row.route,
      lastAccessedAt: row.lastAccessedAt
    }));

    res.json(formattedWork);
  } catch (error) {
    console.error("Error fetching recent work:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * 2. Get Pending PRs
 * Fetches PRs dynamically from GitHub to ensure they are always up-to-date.
 */
export const getPendingPRs = async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.dbUser!.clerkId;
    const token = await getGitHubAccessToken(clerkUserId);

    // Fetch PRs where the user is requested for review or PRs they opened
    const githubQuery = `is:pr is:open author:@me`; 
    const { data } = await axios.get(`https://api.github.com/search/issues?q=${encodeURIComponent(githubQuery)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const prs = data.items.slice(0, 4).map((pr: any) => ({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repositoryName: pr.repository_url.split("/").slice(-1)[0], // extracts repo name from URL
      author: pr.user.login,
      authorAvatarUrl: pr.user.avatar_url,
      timeAgo: calculateTimeAgo(new Date(pr.created_at)),
      status: pr.draft ? "draft" : "open",
    }));

    res.json(prs);
  } catch (error) {
    console.error("Error fetching pending PRs:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * 3. Get Recent Activity
 * Fetches a chronological log of what the AI/User has been doing.
 */
export const getRecentActivity = async (req: Request, res: Response) => {
  try {
    const userId = req.dbUser!.id;

    const query = `
      SELECT 
        a.id, 
        a.activity_type as type, 
        a.metadata, 
        a.created_at,
        repo.name as "repositoryName"
      FROM activity_logs a
      LEFT JOIN repositories repo ON a.repository_id = repo.id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
      LIMIT 20;
    `;
    const { rows } = await pool.query(query, [userId]);

    const formattedActivity = rows.map(row => ({
      id: row.id,
      type: row.type,
      metadata: row.metadata,
      repositoryName: row.repositoryName,
      timeAgo: calculateTimeAgo(row.created_at),
      createdAt: row.created_at
    }));

    res.json(formattedActivity);
  } catch (error) {
    console.error("Error fetching activity:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * Utility: Converts a date to "X mins ago", "Yesterday", etc.
 */
function calculateTimeAgo(dateInput: Date | string): string {
  const date = new Date(dateInput);
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return `Yesterday`;
  return `${days} days ago`;
}