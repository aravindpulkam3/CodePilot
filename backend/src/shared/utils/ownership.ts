import { pool } from "../../config/db.js";

// Chat/interview contexts may enter through a repository, review, or finding ID.
// Check every supplied ID through its repository owner, including parent consistency.
export async function assertOwnedContext(
  userId: string,
  context: { repositoryId?: string | null; reviewId?: string | null; findingId?: string | null },
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 WHERE
      ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM repositories WHERE id = $2 AND user_id = $1))
      AND ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM reviews r JOIN repositories p ON p.id = r.repository_id
        WHERE r.id = $3 AND p.user_id = $1 AND ($2::uuid IS NULL OR p.id = $2)))
      AND ($4::uuid IS NULL OR EXISTS (
        SELECT 1 FROM review_findings f JOIN reviews r ON r.id = f.review_id
        JOIN repositories p ON p.id = r.repository_id
        WHERE f.id = $4 AND p.user_id = $1
          AND ($2::uuid IS NULL OR p.id = $2) AND ($3::uuid IS NULL OR r.id = $3)))`,
    [userId, context.repositoryId ?? null, context.reviewId ?? null, context.findingId ?? null],
  );
  if (rows.length === 0) throw new Error("RESOURCE_NOT_FOUND");
}
