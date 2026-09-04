import { pool } from "../config/db.js";
import { llmService, LLMMessage, ollamaService } from "./llm.service.js";
import { retrievalService } from "./retreival.service.js";
import { Type, Schema } from "@google/genai";
import {
  InterviewConfig,
  InterviewState,
  InterviewTurnEvaluation,
  InterviewFinalAssessment,
} from "../types/interviewTypes.js";
import { interviewPromptBuilder } from "../promptBuilders/interviewPromptBuilder.js";
import { activityLogService } from "./activityLog.service.js";

const interviewEvaluationSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.NUMBER, description: "Score from 0-10" },
    answerQuality: {
      type: Type.STRING,
      enum: ["poor", "weak", "adequate", "strong", "excellent"],
    },
    technicalAccuracy: { type: Type.NUMBER, description: "Score from 0-10" },
    depthOfUnderstanding: { type: Type.NUMBER, description: "Score from 0-10" },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
    missingConcepts: { type: Type.ARRAY, items: { type: Type.STRING } },
    topic: { type: Type.STRING },
    nextAction: {
      type: Type.STRING,
      enum: ["deepen", "clarify", "move_topic"],
    },
    nextDifficulty: {
      type: Type.STRING,
      enum: ["easy", "medium", "hard"],
    },
    nextQuestionType: {
      type: Type.STRING,
      enum: ["follow_up", "depth", "topic_transition"],
    },
    nextQuestion: { type: Type.STRING },
    correction: {
      type: Type.OBJECT,
      properties: {
        needed: { type: Type.BOOLEAN },
        explanation: { type: Type.STRING },
        keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["needed", "explanation", "keyPoints"],
    },
  },
  required: [
    "score",
    "answerQuality",
    "technicalAccuracy",
    "depthOfUnderstanding",
    "strengths",
    "weaknesses",
    "missingConcepts",
    "topic",
    "nextAction",
    "nextDifficulty",
    "nextQuestionType",
    "nextQuestion",
    "correction",
  ],
};

export const interviewFinalAssessmentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    overallAssessment: { type: Type.STRING },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
    score: { type: Type.NUMBER, description: "Score from 0-10" },
  },
  required: ["overallAssessment", "strengths", "weaknesses", "score"],
};

export class InterviewService {
  public async startInterview(
    userId: string,
    config: InterviewConfig,
    clerkUserId?: string,
  ): Promise<{ sessionId: string; firstQuestion: string }> {
    // 1. Create the session
    const { rows } = await pool.query(
      `
      INSERT INTO chat_sessions (user_id, repository_id, type, state)
      VALUES ($1, $2, $3, $4)
      RETURNING id;
    `,
      [
        userId,
        config.repositoryId || null,
        "INTERVIEW",
        JSON.stringify({
          currentTopic: "initialization",
          topicsCovered: [],
          topicsToExplore: config.focusTopics || [],
          difficulty: config.difficulty,
          questionCount: 0,
          depth: config.mode === "repository" ? "repository" : "component",
          lastQuestionType: "initial",
        }),
      ],
    );

    console.log("in the service to start the interview");

    const sessionId = rows[0].id;

    await activityLogService.logEvent({
      userId,
      repositoryId: config.repositoryId || undefined,
      activityType: "INTERVIEW_STARTED",
      metadata: { sessionId, title: "Technical Interview" }
    });

    // 2. Fetch context if repository mode
    let contextData: any = null;
    if (config.mode === "repository" && config.repositoryId && clerkUserId) {
      contextData = await retrievalService.retrieveInterviewStartContext(
        clerkUserId,
        config.repositoryId,
        { maxComponents: 5 },
      );
    }

    // 3. Generate first question
    const messages = interviewPromptBuilder.buildStartPrompt(
      config,
      contextData,
    );

    console.log("length of the system prompt",messages[0].content.length);

    const decision =
      await llmService.generateStructured<InterviewTurnEvaluation>(
        messages,
        interviewEvaluationSchema,
      );

    // 4. Save question to messages
    await pool.query(
      `
      INSERT INTO chat_messages (session_id, role, content, metadata)
      VALUES ($1, $2, $3, $4);
    `,
      [
        sessionId,
        "assistant",
        decision.nextQuestion,
        JSON.stringify({
          type: "question",
          questionType: decision.nextQuestionType,
          topic: decision.topic,
          evaluation: decision, // Store evaluation payload for future review
        }),
      ],
    );

    // 5. Update state
    await pool.query(
      `
      UPDATE chat_sessions 
      SET state = jsonb_set(state, '{currentTopic}', $2::jsonb)
      WHERE id = $1;
    `,
      [sessionId, JSON.stringify(decision.topic)],
    );

    return { sessionId, firstQuestion: decision.nextQuestion };
  }

  public async processAnswer(
    sessionId: string,
    userId: string,
    answer: string,
    clerkUserId?: string,
  ): Promise<{ nextQuestion?: string; assessment?: any; correction?: any }> {
    // 1. Get session state and config
    const sessionRes = await pool.query(
      `SELECT repository_id, state FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (sessionRes.rows.length === 0) throw new Error("Session not found");
    const session = sessionRes.rows[0];
    const state = session.state as InterviewState;
    const repositoryId = session.repository_id;

    console.log("came to process follow ups");

    // 2. Save user answer
    await pool.query(
      `
      INSERT INTO chat_messages (session_id, role, content, metadata)
      VALUES ($1, $2, $3, $4);
    `,
      [sessionId, "user", answer, JSON.stringify({ type: "answer" })],
    );

    // We no longer automatically end based on questionCount since the user wants manual control.
    // However, if we do have a hard upper limit, we can keep it (e.g. 50).
    // Let's remove the automatic completion condition for now, relying on the user to end it.
    /*
    if (state.questionCount >= 10) {
      await pool.query(
        `UPDATE chat_sessions SET status = 'completed' WHERE id = $1`,
        [sessionId],
      );
      return {
        assessment: {
          overallAssessment: "Interview completed.",
          strengths: [],
          weakAreas: [],
        },
      };
    }
    */

    // 3. Get chat history
    const historyRes = await pool.query(
      `SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
    const history: LLMMessage[] = historyRes.rows.map((r) => ({
      role: r.role,
      content: r.content,
    }));

    // 4. Retrieve context if repository mode
    let contextData: any = null;
    if (repositoryId && clerkUserId) {
      const includeCode = state.depth === "implementation";
      contextData = await retrievalService.retrieveInterviewFollowUpContext(
        clerkUserId,
        repositoryId,
        answer,
        { maxComponents: 3, maxFiles: 3, maxCodeChunks: 5, includeCode },
      );
    }

    // 5. Evaluate and get next question
    const messages = interviewPromptBuilder.buildFollowUpPrompt(
      state,
      history,
      contextData,
    );

    const decision =
      await llmService.generateStructured<InterviewTurnEvaluation>(
        messages,
        interviewEvaluationSchema,
      );

    // 6. Save assistant message and update state transactionally
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO chat_messages (session_id, role, content, metadata)
        VALUES ($1, $2, $3, $4);
      `,
        [
          sessionId,
          "assistant",
          decision.nextQuestion,
          JSON.stringify({
            type: "question",
            questionType: decision.nextQuestionType,
            topic: decision.topic,
            evaluation: decision, // Store evaluation payload
          }),
        ],
      );

      // Depth heuristic:
      // Since depth isn't directly returned by the new schema,
      // we can infer it or just keep the current depth unless they move topic.
      // A more robust implementation would allow the LLM to specify depth transitions,
      // but for now we'll stick to state.depth.
      const newState = {
        ...state,
        currentTopic: decision.topic,
        topicsCovered: Array.from(
          new Set([...state.topicsCovered, state.currentTopic]),
        ),
        difficulty: decision.nextDifficulty,
        lastQuestionType: decision.nextQuestionType,
        questionCount: state.questionCount + 1,
      };

      await client.query(
        `
        UPDATE chat_sessions 
        SET state = $2, last_accessed_at = NOW()
        WHERE id = $1;
      `,
        [sessionId, JSON.stringify(newState)],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return { nextQuestion: decision.nextQuestion, correction: decision.correction };
  }

  public async endInterview(sessionId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE chat_sessions SET status = 'completed', last_accessed_at = NOW() WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    await activityLogService.logEvent({
      userId,
      activityType: "INTERVIEW_COMPLETED",
      metadata: { sessionId }
    });
  }

  public async generateInsights(sessionId: string, userId: string): Promise<InterviewFinalAssessment> {
    // 1. Get session state
    const sessionRes = await pool.query(
      `SELECT state FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (sessionRes.rows.length === 0) throw new Error("Session not found");
    const state = sessionRes.rows[0].state as InterviewState;

    // 2. If already generated, just return it
    if (state.assessment) {
      return state.assessment;
    }

    // 3. Get full chat history with metadata
    const historyRes = await pool.query(
      `SELECT role, content, metadata FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );

    // 4. Construct prompt for final review
    const messages = interviewPromptBuilder.buildFinalReviewPrompt(state, historyRes.rows);

    // 5. Generate final review
    const assessment = await ollamaService.generateStructured<InterviewFinalAssessment>(
      messages,
      interviewFinalAssessmentSchema,
    );

    // 6. Save back to state
    const newState = { ...state, assessment };
    await pool.query(
      `UPDATE chat_sessions SET state = $2, last_accessed_at = NOW() WHERE id = $1`,
      [sessionId, JSON.stringify(newState)]
    );

    return assessment;
  }
}

export const interviewService = new InterviewService();
