import { pool } from "../config/db.js";
import { llmService, LLMMessage, ollamaService } from "./llm.service.js";
import { retrievalService } from "./retreival.service.js";
import { Type, Schema } from "@google/genai";
import {
  InterviewConfig,
  InterviewState,
  InterviewTurnEvaluation,
} from "../types/interviewTypes.js";
import { interviewPromptBuilder } from "../promptBuilders/interviewPromptBuilder.js";

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
  ],
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
      INSERT INTO chat_sessions (user_id, repository_id, session_type, state)
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
  ): Promise<{ nextQuestion?: string; assessment?: any }> {
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

    // Check completion
    if (state.questionCount >= 10) {
      // Default limit or from config
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
        SET state = $2
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

    return { nextQuestion: decision.nextQuestion };
  }
}

export const interviewService = new InterviewService();
