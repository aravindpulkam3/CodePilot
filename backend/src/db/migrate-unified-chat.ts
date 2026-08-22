import { pool } from "../config/db.js";

async function runMigration() {
  console.log("Applying unified chat schema migration...");
  
  // Alter chat_sessions columns if they do not already exist
  await pool.query(`
    ALTER TABLE chat_sessions 
    ALTER COLUMN repository_id DROP NOT NULL;
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE chat_sessions 
    ADD COLUMN IF NOT EXISTS review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS finding_id UUID REFERENCES review_findings(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS title VARCHAR(255);
  `);

  // Add partial unique index for 1 issue chat per finding
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_finding_user 
    ON chat_sessions (finding_id, user_id) 
    WHERE type = 'ISSUE_CHAT' AND finding_id IS NOT NULL;
  `);

  // Add indexes
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_review ON chat_sessions(review_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_finding ON chat_sessions(finding_id);
  `);

  // Create interview_sessions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interview_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      current_topic TEXT NOT NULL DEFAULT 'System Architecture',
      topics_covered TEXT[] DEFAULT '{}',
      current_difficulty VARCHAR(20) NOT NULL DEFAULT 'medium',
      question_count INTEGER NOT NULL DEFAULT 0,
      overall_score NUMERIC(4, 2),
      assessment JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Unified chat schema migration completed successfully.");
  await pool.end();
}

runMigration().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
