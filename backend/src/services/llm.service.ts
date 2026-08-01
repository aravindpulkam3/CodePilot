import { GoogleGenAI, Type, Schema } from '@google/genai';
import dotenv from "dotenv";
dotenv.config();

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMService {
  generate(messages: LLMMessage[]): Promise<string>;
  generateStructured<T>(messages: LLMMessage[], schema: Schema): Promise<T>;
}

export class GeminiLLMService implements LLMService {
  private ai: GoogleGenAI;
  private modelName = 'gemini-3.6-flash'; 

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  /**
   * Helper to format generic messages into Gemini's expected format.
   * Gemini treats 'system' instructions differently than standard conversation turns.
   */
  private formatMessages(messages: LLMMessage[]) {
    const systemInstruction = messages.find(m => m.role === 'system')?.content;
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    return { systemInstruction, contents };
  }

  async generate(messages: LLMMessage[]): Promise<string> {
    const { systemInstruction, contents } = this.formatMessages(messages);

    const response = await this.ai.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        systemInstruction,
        temperature: 0.2, // Keep it low for analytical tasks like code review
      }
    });

    return response.text || '';
  }

  async generateStructured<T>(messages: LLMMessage[], schema: Schema): Promise<T> {
    const { systemInstruction, contents } = this.formatMessages(messages);

    console.log("came to generate ai response");

    const response = await this.ai.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        systemInstruction,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: schema,
      }
    });

    const textResult = response.text;
    if (!textResult) throw new Error("LLM returned an empty response.");

    return JSON.parse(textResult) as T;
  }
}

export const llmService = new GeminiLLMService();