// src/services/chatService.ts
import { retrievalService } from './retreival.service.js';
import { CodeChunkSearchResult } from '../types/retrievalTypes.js';
import { LLMMessage, llmService } from './llm.service.js';
import { pool } from '../config/db.js';

export type StreamChunk = 
  | { type: 'sources'; data: CodeChunkSearchResult[] }
  | { type: 'text'; data: string };

export class ChatService {
  
  async createSession(repositoryId: string, type: 'QA' | 'REVIEW' | 'INTERVIEW'): Promise<string> {
    const { rows } = await pool.query(`
      INSERT INTO chat_sessions (repository_id, session_type)
      VALUES ($1, $2)
      RETURNING id;
    `, [repositoryId, type]);
    
    return rows[0].id;
  }

  async getSessionsByRepository(repositoryId: string, type: 'QA' | 'REVIEW' | 'INTERVIEW') {
    const { rows } = await pool.query(`
      SELECT id, repository_id, session_type, created_at 
      FROM chat_sessions 
      WHERE repository_id = $1 AND session_type = $2 
      ORDER BY created_at DESC;
    `, [repositoryId, type]);
    
    return rows;
  }

  async getSessionHistory(sessionId: string) {
    const { rows } = await pool.query(`
      SELECT id, role, content, created_at 
      FROM chat_messages 
      WHERE session_id = $1 
      ORDER BY created_at ASC;
    `, [sessionId]);

    return rows;
  }

  async saveMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<void> {
    await pool.query(`
      INSERT INTO chat_messages (session_id, role, content)
      VALUES ($1, $2, $3);
    `, [sessionId, role, content]);
  }

  async getRecentHistory(sessionId: string, limit: number = 10): Promise<LLMMessage[]> {
    // We order by DESC to get the *most recent* X messages...
    const { rows } = await pool.query(`
      SELECT role, content 
      FROM chat_messages 
      WHERE session_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2;
    `, [sessionId, limit]);

    // ...but we must reverse the array so the AI reads them chronologically (oldest to newest).
    return rows.reverse().map(row => ({
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content
    }));
  }

  async streamRepositoryChat(
    clerkUserId:string,
    repositoryId: string, 
    message: string, 
    chatHistory: any[], // Passed from frontend or fetched from DB
    onChunk: (text: StreamChunk) => void
  ) {
    // 1. Get diverse context chunks
    const retrievedContext = await retrievalService.retrieveQAContext(clerkUserId, repositoryId, message);
    const sources = retrievedContext.codeChunks;

    console.log(sources);

    // 2. Format the sources into a readable string for the prompt [cite: 1484]
    const contextString = sources.map((s, index) => 
      `[Source ${index + 1}]: ${s.filePath} (Line ${s.lineStart})\n\`\`\`\n${s.content}\n\`\`\`\n`
    ).join('\n');

    // 3. Build the System Prompt
    const systemPrompt = `You are a Senior Software Engineer helping explain a codebase. 
Use the provided code context to answer the user's question. 
Always cite your sources using the [Source X] format.

Code Context:
${contextString}`;

    // 4. Combine history and new message
    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: message }
    ];

    // 5. Send initial sources to the client so UI can render citations immediately 
    onChunk({ type: 'sources', data: sources });

    // 6. Stream the LLM response
    const stream = await llmService.stream(messages);
    for await (const chunk of stream) {
      onChunk({ type: 'text',data: chunk.text });
    }

  }


}

export const chatService = new ChatService();