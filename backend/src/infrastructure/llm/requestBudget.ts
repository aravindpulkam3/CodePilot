import type { Schema } from "@google/genai";
import type { LLMMessage } from "./llm.service.js";

export interface LLMRequestBudget {
  contextTokens: number;
  outputTokens: number;
  safetyTokens: number;
}

/**
 * No local provider tokenizer is installed. UTF-8 bytes (not chars/4), plus
 * schema, message framing and a separate safety reserve, deliberately
 * overestimate ordinary code. This is an estimate, not a tokenizer guarantee.
 */
export function estimateRequestTokens(messages: LLMMessage[], schema: Schema): number {
  return Buffer.byteLength(JSON.stringify({ messages, schema }), "utf8") + 512 + messages.length * 32;
}

export function requestFits(messages: LLMMessage[], schema: Schema, budget: LLMRequestBudget): boolean {
  return estimateRequestTokens(messages, schema) + budget.outputTokens + budget.safetyTokens <= budget.contextTokens;
}

export function createRequestBudget(contextTokens: number, maxOutputTokens = 4096): LLMRequestBudget {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("REVIEW_CONTEXT_UNAVAILABLE");
  return {
    contextTokens,
    outputTokens: Math.min(maxOutputTokens, Math.floor(contextTokens / 4)),
    safetyTokens: Math.max(256, Math.ceil(contextTokens * 0.05)),
  };
}

/** Use an explicit request window within the installed model's advertised limit. */
export function ollamaRequestBudget(info: Record<string, unknown>, parameters: string, configured?: string): LLMRequestBudget {
  const architecture = info["general.architecture"];
  const nativeLimit = Number(info[`${architecture}.context_length`]);
  const modelWindow = parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m)?.[1];
  const contextTokens = Number(configured ?? modelWindow ?? nativeLimit);
  if (!Number.isSafeInteger(nativeLimit) || nativeLimit < 1 || contextTokens > nativeLimit) {
    throw new Error("REVIEW_CONTEXT_UNAVAILABLE");
  }
  return createRequestBudget(contextTokens);
}
