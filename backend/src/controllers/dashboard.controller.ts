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
    const userId = req.dbUser!.id; // From auth middleware

    // Example: Querying a 'chat_sessions' or 'user_activities' table
    const query = `
      SELECT 
        id, 
        repo_name AS "repositoryName", 
        activity_type AS "activityType", 
        updated_at
      FROM user_workspaces
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 2;
    `;
    const { rows } = await pool.query(query, [userId]);

    // Format for frontend
    const formattedWork = rows.map(row => ({
      id: row.id,
      repositoryName: row.repositoryName,
      activityType: row.activityType,
      timeAgo: calculateTimeAgo(row.updated_at), // Helper function below
      url: `/repositories/${row.id}`
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

    // Example: Querying an 'activity_logs' table
    const query = `
      SELECT id, description, type, created_at
      FROM activity_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 5;
    `;
    const { rows } = await pool.query(query, [userId]);

    const formattedActivity = rows.map(row => ({
      id: row.id,
      description: row.description,
      type: row.type,
      timeAgo: calculateTimeAgo(row.created_at),
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