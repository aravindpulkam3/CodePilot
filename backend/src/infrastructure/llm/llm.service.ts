import { GoogleGenAI, Type, Schema } from "@google/genai";
import ollama from "ollama";
import dotenv from "dotenv";
import { retryGeneration, retryGenerationStream } from "./providerRetry.js";
import {
  observe,
  type DiagnosticObserver,
} from "../../shared/utils/diagnostics.js";
import {
  createRequestBudget,
  ollamaRequestBudget,
  requestFits,
  type LLMRequestBudget,
} from "./requestBudget.js";
dotenv.config();

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMService {
  /** The model this service calls — persisted as review audit metadata. */
  readonly modelName: string;
  getReviewBudget(): Promise<LLMRequestBudget>;
  generate(messages: LLMMessage[]): Promise<string>;
  generateStructured<T>(
    messages: LLMMessage[],
    schema: Schema,
    budget?: LLMRequestBudget,
    onDiagnostic?: DiagnosticObserver,
  ): Promise<T>;
  stream(
    messages: LLMMessage[],
    onDiagnostic?: DiagnosticObserver,
  ): AsyncGenerator<{ text: string }, void, unknown>;
}

export class GeminiLLMService implements LLMService {
  private ai: GoogleGenAI;
  public readonly modelName = "gemini-3.1-flash-lite";

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async getReviewBudget(): Promise<LLMRequestBudget> {
    const model = await this.ai.models
      .get({ model: this.modelName })
      .catch(() => {
        throw new Error("REVIEW_CONTEXT_UNAVAILABLE");
      });
    return createRequestBudget(
      Number(model.inputTokenLimit),
      Math.min(4096, Number(model.outputTokenLimit)),
    );
  }

  /**
   * Helper to format generic messages into Gemini's expected format.
   * Gemini treats 'system' instructions differently than standard conversation turns.
   */
  private formatMessages(messages: LLMMessage[]) {
    const systemInstruction = messages.find(
      (m) => m.role === "system",
    )?.content;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
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
      },
    });

    return response.text || "";
  }

  async generateStructured<T>(
    messages: LLMMessage[],
    schema: Schema,
    budget?: LLMRequestBudget,
    onDiagnostic?: DiagnosticObserver,
  ): Promise<T> {
    if (budget && !requestFits(messages, schema, budget))
      throw new Error("REVIEW_CONTEXT_TOO_SMALL");
    const { systemInstruction, contents } = this.formatMessages(messages);

    console.log("came to generate ai response");

    const response = await retryGeneration(() => this.ai.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        systemInstruction,
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: schema,
        // Our observable retry loop owns the five-attempt limit.
        httpOptions: { retryOptions: { attempts: 1 } },
        ...(budget ? { maxOutputTokens: budget.outputTokens } : {}),
      },
    }), onDiagnostic);

    observe(onDiagnostic, "provider", {
      provider: "gemini",
      model: this.modelName,
      rawText: response.text ?? null,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
        metadata: response.usageMetadata ?? null,
      },
      settings: {
        temperature: 0.1,
        maxOutputTokens: budget?.outputTokens ?? null,
      },
      finishReason: response.candidates?.map((c) => c.finishReason) ?? null,
    });
    if (
      budget &&
      response.candidates?.some(
        (candidate) => candidate.finishReason === "MAX_TOKENS",
      )
    ) {
      throw new Error("REVIEW_OUTPUT_INCOMPLETE");
    }
    const textResult = response.text;
    if (!textResult) throw new Error("LLM returned an empty response.");

    return JSON.parse(textResult) as T;
  }

  async *stream(
    messages: LLMMessage[],
    onDiagnostic?: DiagnosticObserver,
  ): AsyncGenerator<{ text: string }, void, unknown> {
    const { systemInstruction, contents } = this.formatMessages(messages);
    const ai = this.ai, model = this.modelName;
    yield* retryGenerationStream(async function* () {
      const responseStream = await ai.models.generateContentStream({
        model, contents,
        config: { systemInstruction, temperature: 0.2,
          httpOptions: { retryOptions: { attempts: 1 } } },
      });
      let usage: any = null;
      let finishReason: string | null = null;
      let modelVersion: string | null = null;
      for await (const chunk of responseStream) {
        if (chunk.usageMetadata) usage = { ...usage, ...chunk.usageMetadata };
        finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
        modelVersion = chunk.modelVersion ?? modelVersion;
        if (chunk.text) yield { text: chunk.text };
      }
      observe(onDiagnostic, "qa.usage", {
        provider: "gemini", model, modelVersion, settings: { temperature: 0.2 },
        inputTokens: usage?.promptTokenCount ?? null,
        outputTokens: usage?.candidatesTokenCount ?? null,
        thinkingTokens: usage?.thoughtsTokenCount ?? null,
        metadata: usage, doneReason: finishReason,
      });
      if (finishReason !== "STOP") throw new Error("LLM_OUTPUT_INCOMPLETE");
    }, onDiagnostic);
  }
}

export class OllamaLLMService implements LLMService {
  public readonly modelName = "qwen2.5-coder:7b";

  async getReviewBudget(): Promise<LLMRequestBudget> {
    const model = await ollama.show({ model: this.modelName }).catch(() => {
      throw new Error("REVIEW_CONTEXT_UNAVAILABLE");
    });
    // Ollama's JSON is an object; the installed SDK incorrectly declares a Map.
    const info = model.model_info as unknown as Record<string, unknown>;
    const budget = ollamaRequestBudget(
      info,
      model.parameters,
      process.env.OLLAMA_CONTEXT_LENGTH,
    );
    // Account conservatively for the model's own template/default instructions too.
    budget.safetyTokens += Buffer.byteLength(
      JSON.stringify({
        template: model.template,
        system: model.system,
        messages: model.messages,
      }),
      "utf8",
    );
    return budget;
  }

  private convertToStandardJsonSchema(googleSchema: any): any {
    if (!googleSchema || typeof googleSchema !== "object") return googleSchema;

    const newSchema = { ...googleSchema };

    if (newSchema.type && typeof newSchema.type === "string") {
      newSchema.type = newSchema.type.toLowerCase();
    }

    // 2. Recursively fix all nested properties (for Objects)
    if (newSchema.properties) {
      newSchema.properties = { ...newSchema.properties };
      for (const key in newSchema.properties) {
        newSchema.properties[key] = this.convertToStandardJsonSchema(
          newSchema.properties[key],
        );
      }
    }

    // 3. Recursively fix the 'items' field (for Arrays)
    if (newSchema.items) {
      newSchema.items = this.convertToStandardJsonSchema(newSchema.items);
    }

    return newSchema;
  }

  async generate(messages: LLMMessage[]): Promise<string> {
    const response = await ollama.chat({
      model: this.modelName,
      messages: messages,
      options: {
        temperature: 0.2,
      },
    });

    return response.message.content || "";
  }

  async generateStructured<T>(
    messages: LLMMessage[],
    schema: Schema,
    budget?: LLMRequestBudget,
    onDiagnostic?: DiagnosticObserver,
  ): Promise<T> {
    if (budget && !requestFits(messages, schema, budget))
      throw new Error("REVIEW_CONTEXT_TOO_SMALL");
    console.log("came to generate Ollama structured response");

    const standardSchema = this.convertToStandardJsonSchema(schema);
    console.log("going to generate response");
    const response = await ollama.chat({
      model: this.modelName,
      messages: messages,
      // Recent versions of Ollama support passing a standard JSON schema object
      // to the format parameter to force structured outputs. We cast it as 'any'
      // here just to bypass TypeScript complaining about Google's specific Schema type.
      format: standardSchema as any,
      options: {
        temperature: 0.1,
        ...(budget
          ? { num_ctx: budget.contextTokens, num_predict: budget.outputTokens }
          : {}),
      },
    });

    observe(onDiagnostic, "provider", {
      provider: "ollama",
      model: this.modelName,
      rawText: response.message.content ?? null,
      usage: {
        inputTokens: response.prompt_eval_count ?? null,
        outputTokens: response.eval_count ?? null,
      },
      settings: {
        temperature: 0.1,
        num_ctx: budget?.contextTokens ?? null,
        num_predict: budget?.outputTokens ?? null,
      },
      finishReason: response.done_reason ?? null,
      durationsNs: {
        total: response.total_duration ?? null,
        load: response.load_duration ?? null,
        prompt: response.prompt_eval_duration ?? null,
        generation: response.eval_duration ?? null,
      },
    });
    if (
      budget &&
      (!response.done ||
        response.done_reason === "length" ||
        response.prompt_eval_count + response.eval_count > budget.contextTokens)
    ) {
      throw new Error("REVIEW_OUTPUT_INCOMPLETE");
    }
    const textResult = response.message.content;
    if (!textResult) throw new Error("Ollama returned an empty response.");

    return JSON.parse(textResult) as T;
  }

  async *stream(
    messages: LLMMessage[],
    onDiagnostic?: DiagnosticObserver,
  ): AsyncGenerator<{ text: string }, void, unknown> {
    const responseStream = await ollama.chat({
      model: this.modelName,
      messages: messages,
      stream: true,
      options: {
        temperature: 0.2,
      },
    });

    // Observation is optional and does not alter requests or yielded text.
    for await (const chunk of responseStream) {
      if (chunk.done) observe(onDiagnostic, "qa.usage", {
        provider: "ollama", model: this.modelName, settings: { temperature: 0.2 },
        inputTokens: chunk.prompt_eval_count ?? null, outputTokens: chunk.eval_count ?? null,
        totalDurationNs: chunk.total_duration ?? null, loadDurationNs: chunk.load_duration ?? null,
        promptEvalDurationNs: chunk.prompt_eval_duration ?? null, evalDurationNs: chunk.eval_duration ?? null,
        doneReason: chunk.done_reason ?? null,
      });
      if (chunk.message?.content) {
        yield { text: chunk.message.content };
      }
    }
  }
}

export const llmService = new GeminiLLMService();
export const ollamaService = new OllamaLLMService();

/** One production/evaluation selection for repository Q&A. */
export const repositoryQALLM = llmService;
