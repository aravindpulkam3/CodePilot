import { LLMMessage } from "../services/llm.service.js";
import { InterviewState } from "../types/interviewTypes.js";

interface InterviewContext {
  components?: any[];
  files?: any[];
  codeChunks?: any[];
  repository?: any;
  architecture?: any;
}

export class InterviewPromptBuilder {
  private truncateContext(items: any[], maxItems: number): any[] {
    if (!items || items.length === 0) return [];
    return items.slice(0, maxItems);
  }

  public buildStartPrompt(
    config: any,
    context?: InterviewContext,
  ): LLMMessage[] {
    let contextStr = "";
    if (context) {
      if (context.repository) {
        contextStr += `Repository Overview:\n${JSON.stringify(context.repository, null, 2)}\n\n`;
      }
      if (context.architecture) {
        contextStr += `Architecture:\n${JSON.stringify(context.architecture, null, 2)}\n\n`;
      }
      if (context.components && context.components.length > 0) {
        const truncated = this.truncateContext(context.components, 5);
        contextStr += `Components:\n${JSON.stringify(truncated, null, 2)}\n\n`;
      }
    }

    const systemPrompt = `You are a professional technical interviewer focusing on preparation.
Mode: ${config.mode}
Difficulty: ${config.difficulty}
${config.domain ? `Domain: ${config.domain}` : ""}
${config.language ? `Language: ${config.language}` : ""}
${config.technologies ? `Technologies: ${config.technologies.join(", ")}` : ""}

${contextStr ? `Repository Context:\n${contextStr}` : ""}

Ask the very first interview question to get started. For a repository interview, start at a high level (e.g. architecture or overview). For a general interview, start with a fundamental concept in the selected domain.`;

    return [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: "Please generate the first interview question based on the provided context.",
      },
    ];
  }

  public buildFollowUpPrompt(
    state: InterviewState,
    history: LLMMessage[],
    context?: InterviewContext,
  ): LLMMessage[] {
    let contextStr = "";
    if (context) {
      if (context.components && context.components.length > 0) {
        const truncated = this.truncateContext(context.components, 3);
        contextStr += `Components:\n${JSON.stringify(truncated, null, 2)}\n\n`;
      }
      if (context.files && context.files.length > 0) {
        const truncated = this.truncateContext(context.files, 3);
        contextStr += `Files:\n${JSON.stringify(truncated, null, 2)}\n\n`;
      }
      if (context.codeChunks && context.codeChunks.length > 0) {
        // Only include code chunk summaries or truncated chunks to avoid exceeding limits
        const truncated = this.truncateContext(context.codeChunks, 5).map(c => ({
          file_path: c.file_path,
          summary: c.summary,
          code: c.content?.substring(0, 1500) // Truncate very long code blocks
        }));
        contextStr += `Code Snippets:\n${JSON.stringify(truncated, null, 2)}\n\n`;
      }
    }

    const systemPrompt = `You are a professional technical interviewer focusing on preparation. Evaluate the candidate's latest answer.

Current Interview State:
- Topic: ${state.currentTopic}
- Depth: ${state.depth}
- Difficulty: ${state.difficulty}
- Topics Covered: ${state.topicsCovered.join(", ")}

${contextStr ? `Repository Context for reference (Do NOT leak the code directly, use it to evaluate accuracy and formulate relevant follow-ups):\n${contextStr}` : ""}

Evaluate the candidate's latest answer, decide whether to drill deeper, clarify, or move to a new topic. Adjust difficulty if adaptive. 
You must score their response, identify strengths/weaknesses, and generate the next question.
Respond ONLY using the provided structured JSON schema.`;

    return [
      { role: "system", content: systemPrompt },
      ...history,
    ];
  }
}

export const interviewPromptBuilder = new InterviewPromptBuilder();
