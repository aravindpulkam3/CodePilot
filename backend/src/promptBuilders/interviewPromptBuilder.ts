import { LLMMessage } from "../services/llm.service.js";
import { InterviewConfig, InterviewState, MAX_TURNS_ON_FOCUS, MAX_TURNS_ON_MODULE } from "../types/interviewTypes.js";
import { InterviewStartContext, InterviewFollowUpContext, ModuleInventoryEntry } from "../types/retrievalTypes.js";

/**
 * The single most important rule in either prompt. Stated as an explicit
 * instruction with negative examples because the model's default, absent
 * this, is to slide into generic CS-quiz questions the moment retrieval
 * comes back thin — which is silent and looks identical to a working
 * interview from the outside.
 *
 * Deliberately does NOT require citing a file/symbol in the question text —
 * that used to be the rule, and the model dutifully complied by opening
 * nearly every question with "In `file.ts`, ...", which is most of why the
 * interview read as robotic. The requirement that actually matters (the
 * question's SUBSTANCE must be real and repo-specific) is kept; the
 * requirement that was producing citation-first phrasing is dropped. Losing
 * the citation also loses the model's built-in hallucination check ("can I
 * literally point to this filename"), so an explicit anti-invention clause
 * replaces it below — don't drop one without the other.
 */
const GROUNDING_BAR = `Grounding rule — the single most important rule here:
Every question's SUBSTANCE must come from a real, specific fact in the context below — a behavior,
a design decision, a naming choice, a control-flow detail, an edge case, a tradeoff the code embodies.
You may not ask something a competent engineer could answer without having read this repository.

Naming a file path or symbol out loud is OPTIONAL, not required. Do it when it's the natural way to be
precise (the candidate already brought it up, or two similar things need disambiguating) — not as a
reflex on every turn. Most of the time, describe the mechanism or scenario in plain language instead
("the endpoint that redirects short links and logs a click" is fine without naming the file).

If you are not certain something is true of this specific repository, do not assert it as fact. Ask
about it — don't claim it. Never invent a detail (a batching strategy, a caching layer, a queue) that
isn't actually shown in the context below just to sound specific.

BAD (generic quiz, no repo grounding):        "What is Redis used for?" / "Explain BullMQ."
BAD (sounds specific, but invented):          "Why do you batch those writes before flushing to Mongo?"
                                               <- don't imply this if nothing below shows batching
GOOD (names the file, precision requires it): "config/redis.ts opens two separate Redis connections on
                                               ports 6379 and 6380. Why, and what would break if merged?"
GOOD (same grounding, no filename needed):    "Redirecting a short link and logging that click happen in
                                               the same request. What happens if two of those land at once?"
GOOD (grounded in README, not code):          "The README frames this as optimized for read-heavy
                                               traffic. Where in the design do you actually see that?"

If the context below is empty, say so honestly instead of inventing repository details you haven't seen.`;

const SOURCE_AUTHORITY = `Source authority:
- Documentation ([Doc N]) states the maintainer's documented intent, setup, and project description — authoritative for WHAT THE PROJECT IS FOR and HOW TO RUN IT.
- Code ([Source N] / [Stay N]) is authoritative for WHAT THE SYSTEM ACTUALLY DOES TODAY.
- If documentation and code disagree, trust the code — and say so; that disagreement is itself excellent interview material.
- Documentation is good material for WHY-shaped questions (design intent, tradeoffs, the reasoning behind a choice) rather than definitional ones ("what is X") — but don't force every such question into one fixed sentence shape. If a [Doc N] block and a [Source N]/[Stay N] block appear together and actually disagree, that discrepancy is itself excellent interview material — point it out.`;

/** Common fields across RepositorySummary/ArchitectureSummary/ComponentSummary — enough for a short orientation block without a per-type renderer. */
function renderSummaryBlock(summary: unknown): string {
  const s = summary as any;
  if (!s) return "";
  return truncate(
    [
      s.purpose ? `Purpose: ${s.purpose}` : null,
      s.summary ? `Summary: ${s.summary}` : null,
      s.architectureStyle ? `Style: ${s.architectureStyle}` : null,
      s.majorComponents?.length ? `Major components: ${s.majorComponents.join(", ")}` : null,
      s.responsibilities?.length ? `Responsibilities: ${s.responsibilities.join(", ")}` : null,
      s.techStack?.length ? `Tech stack: ${s.techStack.join(", ")}` : null,
      s.technologies?.length ? `Technologies: ${s.technologies.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    1000,
  );
}

function renderModuleList(modules: ModuleInventoryEntry[]): string {
  return modules.map((m) => `- ${m.module} (${m.fileCount} file${m.fileCount === 1 ? "" : "s"})`).join("\n");
}

/** Truncates PRESERVING structure (newlines, code formatting) — unlike
 * utils/readmeDebugLog.ts's docPreview, which collapses whitespace for a
 * single-line LOG message and would mangle code shown to the model. */
function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Renders as many whole items as fit under a combined character budget,
 * always including at least the first even if it alone exceeds the cap.
 * This is how "smallest amount of highly relevant context" (not a token
 * budget service) is enforced per block — see the context-budget table in
 * the design doc.
 */
function renderCapped<T>(items: T[], render: (item: T, index: number) => string, maxChars: number): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const piece = render(items[i], i);
    if (parts.length > 0 && total + piece.length > maxChars) break;
    parts.push(piece);
    total += piece.length;
  }
  return parts.join("\n\n");
}

export class InterviewPromptBuilder {
  public buildStartPrompt(config: InterviewConfig, context: InterviewStartContext): LLMMessage[] {
    // v2: DELIBERATELY no code block. The previous prompt fed seed code
    // chunks and told the model to "prefer" the architecturally central
    // ones — an instruction that failed in practice, because once retrieved
    // a Mongoose schema field and an entry-point handler are structurally
    // indistinguishable. The fix is that no code is offered at all: turn 1
    // is a REPOSITORY-scope orientation question, grounded only in the
    // module inventory, documentation, and (READY-gated) summaries below.
    const docBlock = renderCapped(
      context.docChunks,
      (d, i) => `[Doc ${i + 1}]: ${d.filePath} § ${d.sectionPath}\n${truncate(d.content, 1200)}`,
      2500,
    );

    // READY-gated — see retreival.service.ts. Absent while
    // SEARCHABLE-but-not-READY rather than presenting a summary that may
    // describe an older revision than the code retrieved alongside it.
    const overviewBlock = renderSummaryBlock(context.repository);
    const architectureBlock = renderSummaryBlock(context.architecture);
    const moduleBlock = renderCapped(context.moduleInventory, (m) => `- ${m.module} (${m.fileCount} file${m.fileCount === 1 ? "" : "s"})`, 2000);

    const hasAnyContext = Boolean(overviewBlock || architectureBlock || docBlock || moduleBlock);

    const sections: string[] = [
      `You are a senior engineer conducting a technical interview about THIS SPECIFIC repository.`,
      `Difficulty: ${config.difficulty}${config.domain ? ` | Domain: ${config.domain}` : ""}`,
      ``,
      GROUNDING_BAR,
      ``,
      SOURCE_AUTHORITY,
    ];

    if (!hasAnyContext) {
      sections.push(
        ``,
        `No indexed repository content is available yet. Do NOT invent repository details. Set`,
        `nextFocus.filePath, nextFocus.module and nextFocus.symbolName to null, and make interviewerMessage`,
        `state plainly that indexing hasn't produced content yet and to try again shortly.`,
      );
    } else {
      if (overviewBlock) sections.push(``, `## Repository Overview (fully indexed)`, overviewBlock);
      if (architectureBlock) sections.push(``, `## Architecture (fully indexed)`, architectureBlock);
      if (docBlock) sections.push(``, `## Documentation`, docBlock);
      if (moduleBlock) sections.push(``, `## Repository areas`, moduleBlock);
      sections.push(
        ``,
        `Ask the FIRST interview question — an ORIENTATION question, not an implementation one. You`,
        `have NOT been given any code, on purpose: do not ask about a specific function, field, or`,
        `line — none was shown to you, and asking about one would mean inventing it. Ask something`,
        `that gets the candidate talking about what this project does, its overall architecture, or`,
        `how its major areas fit together, using whatever of the material above is present.`,
        ``,
        `The question does NOT need to name a specific file, symbol, or even one of the areas above —`,
        `a broad "walk me through this project and how its major pieces fit together" is a fully`,
        `valid opening question. It only needs to be genuinely grounded in the material above, not`,
        `answerable purely from general CS/framework knowledge.`,
        ``,
        `Set nextFocus.filePath and nextFocus.symbolName to null. Set nextFocus.module to null unless`,
        `you are deliberately opening on ONE specific area from "## Repository areas" above (in which`,
        `case it must be EXACTLY one of those area names, copied verbatim) — opening at the`,
        `repository level (module also null) is equally valid and often the better choice for question 1.`,
      );
    }

    // This is turn 1 — there's no real prior answer. score/strengths/etc.
    // are placeholders; only interviewerMessage, nextAction, and nextFocus
    // matter. A dedicated question-only schema that drops this fabrication
    // entirely is deferred — see the design doc's Tier 3.
    sections.push(
      ``,
      `This is turn 1 — there is no prior answer to evaluate. Set nextAction to "NEW_TOPIC" and fill`,
      `the evaluation fields (score, strengths, weaknesses, etc.) with neutral placeholders, since`,
      `nothing has been answered yet.`,
    );

    return [
      { role: "system", content: sections.join("\n") },
      { role: "user", content: "Generate the first interview question." },
    ];
  }

  public buildFollowUpPrompt(
    state: InterviewState,
    history: LLMMessage[],
    context: InterviewFollowUpContext,
  ): LLMMessage[] {
    const granularity = context.granularity;

    // GROUNDING — evidence for judging the answer to the question just
    // asked. Code only at FILE granularity (see retreival.service.ts).
    const groundingCode = renderCapped(
      context.groundingCode,
      (c, i) => `[Source ${i + 1}]: ${c.filePath} (Lines ${c.lineStart}-${c.lineEnd})\n\`\`\`\n${truncate(c.content, 1500)}\n\`\`\``,
      4000,
    );
    const groundingDocs = renderCapped(
      context.groundingDocs,
      (d, i) => `[Doc ${i + 1}]: ${d.filePath} § ${d.sectionPath}\n${truncate(d.content, 1000)}`,
      2000,
    );
    const groundingSummaryBlock = renderSummaryBlock(context.groundingSummary);

    // STAY — deeper material at the SAME granularity as the question just asked.
    const stayCode = renderCapped(
      context.stayCode,
      (c, i) => `[Stay ${i + 1}]: ${c.filePath} (Lines ${c.lineStart}-${c.lineEnd})\n\`\`\`\n${truncate(c.content, 1200)}\n\`\`\``,
      3000,
    );
    const stayDocs = renderCapped(
      context.stayDocs,
      (d, i) => `[Deeper Doc ${i + 1}]: ${d.filePath} § ${d.sectionPath}\n${truncate(d.content, 1000)}`,
      2000,
    );
    const staySummaryBlock = renderSummaryBlock(context.staySummary);

    // NARROW — offered ALONGSIDE stay, one level finer. Names only.
    const narrowModulesBlock = renderModuleList(context.narrowModules);
    const narrowFilesBlock = context.narrowFiles.map((f) => `- ${f}`).join("\n");

    // FRONTIER — unexplored areas, for NEW_TOPIC. Names only.
    const frontierBlock = renderModuleList(context.frontierModules);

    const focusLine =
      granularity === "FILE"
        ? `${state.currentFocus?.filePath}${state.currentFocus?.symbolName ? ` (${state.currentFocus.symbolName})` : ""}`
        : granularity === "MODULE"
          ? `${state.currentFocus?.module} (area-level — no single file yet)`
          : "(repository-wide — no area or file)";

    const fileBoundReached = (state.turnsOnCurrentFocus ?? 0) >= MAX_TURNS_ON_FOCUS;
    const moduleBoundReached = (state.turnsOnCurrentModule ?? 0) >= MAX_TURNS_ON_MODULE;
    const tooLongAtRepositoryScope = granularity === "REPOSITORY" && (state.turnsOnCurrentModule ?? 0) > 2;
    const gapsLine = state.knownGaps.length > 0 ? state.knownGaps.join("; ") : "(none yet)";

    const sections: string[] = [
      `You are a senior engineer conducting a technical interview about THIS SPECIFIC repository.`,
      `Evaluate the candidate's latest answer, then decide what to ask next.`,
      ``,
      GROUNDING_BAR,
      ``,
      SOURCE_AUTHORITY,
      ``,
      `## Interview state`,
      `- Current scope: ${granularity} — ${focusLine}`,
      `- Turns spent on this exact file: ${state.turnsOnCurrentFocus ?? 0}` +
        (granularity === "FILE" && fileBoundReached
          ? `  <- consider leaving this specific file now (a sibling file in the same area, or step back` +
            `    to the area/repository level) — this does NOT require NEW_TOPIC; staying on the same` +
            `    broader subject is fine.`
          : ""),
      `- Turns spent on this area: ${state.turnsOnCurrentModule ?? 0}` +
        (moduleBoundReached
          ? `  <- LIMIT REACHED (max ${MAX_TURNS_ON_MODULE}). You MUST set nextAction to "NEW_TOPIC" and move to one of the unexplored areas below.`
          : ""),
      ...(tooLongAtRepositoryScope
        ? [
            `- You've stayed at repository-wide scope for ${state.turnsOnCurrentModule} turns without` +
              ` committing to an area — your next question should narrow to a specific area (set nextFocus.module).`,
          ]
        : []),
      `- Difficulty: ${state.difficulty}` +
        (state.difficultyMode === "adaptive" ? ` (adaptive — you may change nextDifficulty)` : ` (fixed by the candidate — nextDifficulty is ignored unless adaptive, so set it to ${state.difficulty})`),
      `- Known gaps to revisit if relevant: ${gapsLine}`,
      `- Do not repeat a question already covered in the conversation history below.`,
      ``,
      `## Adaptation policy — choose nextAction from the answer you're evaluating right now:`,
      `- Answer strong/excellent -> DEEP_DIVE: go deeper on the current subject. This does NOT have to` +
        ` narrow — another question at the SAME scope (e.g. a further architecture/tradeoff question,` +
        ` or another aspect of the same area) is just as valid as narrowing to a more specific area or` +
        ` file. Narrow only when the material below genuinely calls for it.`,
      `- Answer partial with specific gaps -> FOLLOW_UP: probe ONE missing concept by name, at the same` +
        ` scope (may narrow too, same rule as DEEP_DIVE).`,
      `- Answer reveals a misconception -> FOLLOW_UP: challenge it, citing the grounding evidence below` +
        ` that contradicts it.`,
      `- Answer poor/weak -> SIMPLIFY: drop difficulty, ask about a prerequisite — usually the same` +
        ` scope, or step back to a broader one if that's genuinely simpler.`,
      `- Area limit reached above, or this subject is genuinely fully covered -> NEW_TOPIC: move to` +
        ` "## Unexplored areas" below. NEW_TOPIC is the ONLY action allowed to move to a different area` +
        ` than the current one — FOLLOW_UP/DEEP_DIVE/SIMPLIFY must stay within it.`,
      ``,
      `## How to respond (voice of interviewerMessage)`,
      `interviewerMessage is your entire next spoken turn, not "the question." There is no fixed shape` +
        ` for it. Sometimes the most natural thing a real interviewer says is a direct question with no` +
        ` acknowledgment at all — that is a valid, often preferable outcome, not something to avoid. Do` +
        ` NOT default to a "reaction sentence + question" template on every turn. When you do react, it` +
        ` flows directly into the question as ONE continuous thought — never two stapled parts (no` +
        ` feedback block followed by a question).`,
      `Base your reaction — if you have one — on something SPECIFIC the candidate actually said: a` +
        ` claim, a term they used, an assumption, a gap, a contradiction, or something genuinely` +
        ` interesting. Never react to nextAction as an abstract label, and never react in a way that` +
        ` could have been written without reading their actual words.`,
      `Your options on any given turn: continue with a direct question, acknowledge something specific,` +
        ` challenge an interesting or strong-looking claim, clarify a misconception, correct a factual` +
        ` gap, or move on to something else — pick whichever actually fits what the candidate just said.` +
        ` answerQuality can nudge which of these is more likely to fit (a strong answer makes a` +
        ` challenge more likely to be worthwhile; a weak one makes a correction more likely) — it is NOT` +
        ` a rule that strong must always be challenged, adequate must always be acknowledged, or weak` +
        ` must always be corrected. The candidate's actual words and the conversation so far are what` +
        ` decide, every time. Never a standalone "Great answer!" / "Excellent!" as a reflex, and never a` +
        ` correction delivered as a verdict rather than a natural next question.`,
      `When correction.needed is true, explanation/keyPoints are the internal record — say the same` +
        ` substance conversationally, in your own words, inside interviewerMessage. No bullet points, no` +
        ` "Corrective Feedback" heading, and no separate paragraph — it's part of the same natural turn.`,
      `Even if the candidate names a specific file or symbol themselves, that does NOT obligate you to` +
        ` ask about its implementation. If your current scope is REPOSITORY or MODULE, stay at that` +
        ` conceptual level — role, responsibility, how it fits into the workflow — unless nextFocus is` +
        ` deliberately narrowing to FILE this turn. A candidate mentioning a filename in their answer is` +
        ` not itself a reason to ask an implementation-mechanics question about that file.`,
      `Vary your construction across turns — don't let any one opening become a tic (e.g. always "Good` +
        ` point, but...", or always a bare question). Let it come out differently depending on what was` +
        ` actually said.`,
      `NEW_TOPIC: a short natural pivot ("Okay, that's solid — let's look at a different part of the` +
        ` system.") reads better than cutting cold from a correction into an unrelated question, but` +
        ` don't invent false continuity ("building on that...") when the new topic genuinely doesn't` +
        ` build on the last one.`,
      `Never expose score, technicalAccuracy, depthOfUnderstanding, answerQuality, nextAction,` +
        ` nextFocus, or retrieval/coverage details inside interviewerMessage.`,
    ];

    if (groundingCode || groundingDocs || groundingSummaryBlock) {
      sections.push(``, `## Evidence for evaluating the answer (do not leak verbatim — use it to judge accuracy)`);
      if (groundingSummaryBlock) sections.push(groundingSummaryBlock);
      if (groundingDocs) sections.push(groundingDocs);
      if (groundingCode) sections.push(groundingCode);
    }

    if (stayCode || stayDocs || staySummaryBlock) {
      sections.push(
        ``,
        `## Material to go deeper WITHOUT changing scope (for FOLLOW_UP / DEEP_DIVE / SIMPLIFY that stay at ${granularity})`,
      );
      if (staySummaryBlock) sections.push(staySummaryBlock);
      if (stayDocs) sections.push(stayDocs);
      if (stayCode) sections.push(stayCode);
    }

    if (narrowModulesBlock || narrowFilesBlock) {
      sections.push(
        ``,
        `## One level more specific, if you choose to narrow (for FOLLOW_UP / DEEP_DIVE / SIMPLIFY that DO narrow)`,
      );
      if (narrowModulesBlock) sections.push(narrowModulesBlock);
      if (narrowFilesBlock) sections.push(narrowFilesBlock);
    }

    if (frontierBlock) {
      sections.push(``, `## Unexplored areas (for NEW_TOPIC)`, frontierBlock);
    }

    if (
      !groundingCode && !groundingDocs && !groundingSummaryBlock &&
      !stayCode && !stayDocs && !staySummaryBlock &&
      !narrowModulesBlock && !narrowFilesBlock && !frontierBlock
    ) {
      sections.push(
        ``,
        `No repository context was retrieved for this turn. Say so honestly in your feedback rather`,
        `than inventing specifics, and ask a question that only depends on the conversation so far.`,
      );
    }

    sections.push(
      ``,
      `nextFocus.filePath must be EXACTLY one of these paths (copied verbatim), and ONLY if your next` +
        ` question targets a specific implementation: ` +
        (context.contextPaths.length > 0 ? context.contextPaths.join(", ") : "(none available this turn)"),
      `nextFocus.module must be EXACTLY one of these area names (copied verbatim), and ONLY if your` +
        ` next question targets a specific area with no single file chosen yet: ` +
        (context.contextModules.length > 0 ? context.contextModules.join(", ") : "(none available this turn)"),
      `Set at most one of filePath/module — leave module null when filePath is set (it is derived`,
      `automatically). Both null means a genuinely repository-wide question.`,
      ``,
      `Score the candidate's answer and identify strengths/weaknesses/missingConcepts for the internal`,
      `record. Populate 'correction' (needed/explanation/keyPoints) when the answer is incorrect or`,
      `incomplete — this is internal bookkeeping, not what the candidate sees; see "How to respond"`,
      `above for how its substance actually reaches them, inside interviewerMessage.`,
      `Respond ONLY using the provided structured JSON schema.`,
    );

    return [{ role: "system", content: sections.join("\n") }, ...history];
  }

  public buildFinalReviewPrompt(
    state: InterviewState,
    history: any[]
  ): LLMMessage[] {
    const formattedHistory = history.map(msg => {
      let content = msg.role === 'assistant' ? msg.content : `Candidate Answer: ${msg.content}`;

      if (msg.role === 'assistant' && msg.metadata) {
        try {
          const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
          if (meta.evaluation) {
            content += `\n[Internal Evaluation: Score ${meta.evaluation.score}/10, Quality: ${meta.evaluation.answerQuality}, Strengths: ${meta.evaluation.strengths?.join(', ')}, Weaknesses: ${meta.evaluation.weaknesses?.join(', ')}]`;
          }
        } catch (e) {
          // ignore parsing errors
        }
      }
      return { role: msg.role, content };
    });

    const systemPrompt = `You are an expert technical interviewer. The interview has just concluded.
Your task is to review the entire interview transcript and the internal per-turn evaluations, and generate a comprehensive final assessment of the candidate.

Topics Covered: ${(state.topicsCovered ?? []).join(", ")}
Known Gaps Never Resolved: ${(state.knownGaps ?? []).join(", ") || "None"}
Final Difficulty: ${state.difficulty}

Provide a structured final review with an overall assessment, key strengths, primary weaknesses (areas for improvement), and a final score (0-10).
Respond ONLY using the provided structured JSON schema.`;

    return [{ role: "system", content: systemPrompt }, ...formattedHistory];
  }
}

export const interviewPromptBuilder = new InterviewPromptBuilder();
