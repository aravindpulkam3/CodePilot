export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EmbeddingQueryResult {
  text: string;
  usedHistory: boolean;
}

/** How much of the previous user turn to fold in when resolving a reference. */
const MAX_PREVIOUS_TURN_CHARS = 300;

/**
 * A message is short and pronoun/deictic-heavy enough that it likely can't
 * be embedded on its own — "why did they choose that?" carries no retrievable
 * subject without the turn before it. Length-gated so a long, self-contained
 * question that happens to contain "this" or "that" doesn't false-positive;
 * genuine follow-ups are reliably both short AND anaphora-dominated.
 */
const ANAPHORA_PATTERN = /\b(it|that|this|these|those|they|them|there|its|their)\b/i;
const MAX_ANAPHORIC_WORDS = 10;

export function looksAnaphoric(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > MAX_ANAPHORIC_WORDS) return false;
  return ANAPHORA_PATTERN.test(trimmed);
}

/**
 * Builds the text actually embedded for this turn's retrieval.
 *
 * Deliberately NOT "embed the whole conversation" — only the single
 * immediately-prior USER turn is ever blended in (never the assistant's
 * answer, which is long, carries its own [Source N]/[Doc N] markers, and
 * would dilute the embedding rather than sharpen it), and only when
 * looksAnaphoric fires. The current message stays the dominant signal: it
 * comes first in the constructed string, with just enough prior text
 * appended to resolve the dangling reference.
 *
 * This text is used ONLY to compute the embedding vector for this turn's
 * retrieval — it is never itself written into the rendered prompt context.
 * See "Avoiding duplication between conversation history and retrieved
 * evidence" in the Q&A retrieval plan.
 *
 * Deferred, not implemented: an LLM query-rewrite ("condense question") call
 * as an escalation path, only worth adding if this heuristic provably
 * plateaus against real conversations — not preemptively, and even then
 * gated to just the turns looksAnaphoric already flags.
 */
export function buildQAEmbeddingQuery(
  currentMessage: string,
  recentHistory: ConversationTurn[],
): EmbeddingQueryResult {
  if (!looksAnaphoric(currentMessage)) {
    return { text: currentMessage, usedHistory: false };
  }

  const previousUserTurn = [...recentHistory].reverse().find((t) => t.role === "user");
  if (!previousUserTurn || !previousUserTurn.content.trim()) {
    return { text: currentMessage, usedHistory: false };
  }

  const truncatedPrevious =
    previousUserTurn.content.length > MAX_PREVIOUS_TURN_CHARS
      ? previousUserTurn.content.slice(0, MAX_PREVIOUS_TURN_CHARS)
      : previousUserTurn.content;

  return {
    text: `${currentMessage} — referring back to: ${truncatedPrevious}`,
    usedHistory: true,
  };
}
