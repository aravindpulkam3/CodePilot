import { ChatContextProvider, ChatContextPayload, ChatSessionRecord } from "../chat.types.js";
import { pool } from "../../../config/db.js";

export class InterviewContextProvider implements ChatContextProvider {
  async buildContext(
    session: ChatSessionRecord,
    _userMessage: string
  ): Promise<ChatContextPayload> {
    // 1. Fetch interview state from interview_sessions
    const { rows } = await pool.query(
      `SELECT * FROM interview_sessions WHERE session_id = $1`,
      [session.id]
    );

    const interviewState = rows[0] || {
      current_topic: "System Architecture & Engineering Practices",
      current_difficulty: "medium",
      topics_covered: [],
      question_count: 0,
    };

    const topicsStr =
      interviewState.topics_covered && interviewState.topics_covered.length > 0
        ? interviewState.topics_covered.join(", ")
        : "None yet";

    const systemPrompt = `You are a Principal Software Engineer conducting a high-caliber technical interview.

Interview Progress & State:
- Current Focus Topic: ${interviewState.current_topic}
- Current Difficulty Level: ${interviewState.current_difficulty}
- Topics Already Covered: ${topicsStr}
- Questions Completed: ${interviewState.question_count}

Interview Guidelines:
1. Assess the candidate's answers for technical accuracy, design tradeoffs, edge-case awareness, and production readiness.
2. If the candidate answers well, provide brief positive validation and ask a deeper or more challenging follow-up question.
3. If the candidate makes an error or misses a key concept, explain the gap constructively and guide them.
4. Keep the conversational flow engaging, realistic, and focused on practical software engineering.`;

    return {
      systemPrompt,
      metadata: {
        interviewState,
      },
    };
  }

  async onAfterResponse(
    session: ChatSessionRecord,
    _fullAiResponse: string
  ): Promise<void> {
    // Update question count and timestamp in interview_sessions
    await pool.query(
      `UPDATE interview_sessions 
       SET question_count = question_count + 1, updated_at = NOW() 
       WHERE session_id = $1`,
      [session.id]
    );
  }
}
