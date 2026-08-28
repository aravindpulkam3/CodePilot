import { Type, Schema } from '@google/genai';
import type {
  ArchitectureSummary,
  ComponentSummary,
  FileASTMetadata,
  FileSummary,
  RepositorySummary,
} from "../types/summaryTypes.js";
import { LLMService, LLMMessage } from "./llm.service.js";

const QUALITY_RULES = `
Rules:
- Explain intent, not implementation. Prefer domain terminology over generic words. Say why something exists, not a line-by-line account of what it does.
- Summaries should help an engineer understand the repository architecture quickly.
- Avoid mentioning implementation details that can be inferred from code.
- Do not repeat information already represented by another field.
- Never invent dependencies, classes, or functions that aren't in the provided data.
- Never copy source code into the summary text.
- Keep it stable across refactors: describe responsibility and role, not internal structure that will change.
- Every field must stand on its own — a reader with no other context should understand it.
- Return ONLY valid JSON matching the schema. No markdown, no commentary, no code fences.
- If there is insufficient evidence to confidently determine a field, return an empty array rather than inferring or hallucinating.
`.trim();

// ---------------------------------------------------------------- Stage 3

export async function generateFileSummary(
  meta: FileASTMetadata,
  sourceCode: string,
  module: string,
  llm: LLMService,
): Promise<FileSummary> {
  const system = `You write a single JSON summary of one source file for a code-intelligence platform. ${QUALITY_RULES}`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      nodeType: { type: Type.STRING },
      name: { type: Type.STRING },
      path: { type: Type.STRING },
      module: { type: Type.STRING },
      purpose: { type: Type.STRING, description: "Exactly one sentence: why this file exists" },
      summary: { type: Type.STRING, description: "The file's role in the repository, not a function-by-function walkthrough" },
      responsibilities: { type: Type.ARRAY, items: { type: Type.STRING } },
      technologies: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Libraries, frameworks, databases, protocols actually used" },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Terms useful for semantic retrieval" },
      importantClasses: { type: Type.ARRAY, items: { type: Type.STRING } },
      importantFunctions: { type: Type.ARRAY, items: { type: Type.STRING } },
      externalDependencies: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: [
      "nodeType",
      "name",
      "path",
      "module",
      "purpose",
      "summary",
      "responsibilities",
      "technologies",
      "keywords",
      "importantClasses",
      "importantFunctions",
      "externalDependencies"
    ],
  };

  const prompt = `File path: ${meta.filePath}\nModule: ${module}\nLanguage: ${meta.language}\n\nAST-extracted facts (ground truth — do not contradict these):\nImports: ${JSON.stringify(meta.imports)}\nExports: ${JSON.stringify(meta.exports)}\nClasses: ${JSON.stringify(meta.classes)}\nInterfaces: ${JSON.stringify(meta.interfaces)}\nFunctions: ${JSON.stringify(meta.functions)}\nDecorators: ${JSON.stringify(meta.decorators)}\nInheritance: ${JSON.stringify(meta.inheritance)}\n\nSource code:\n${sourceCode}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  return llm.generateStructured<FileSummary>(messages, schema);
}

// ---------------------------------------------------------------- Stage 4

export async function generateComponentSummary(
  moduleName: string,
  fileSummaries: FileSummary[],
  llm: LLMService,
): Promise<ComponentSummary> {
  const system = `You write a single JSON summary of a repository component/module for a code-intelligence platform. ${QUALITY_RULES}\nYou are given ONLY file summaries, never source code — produce a true semantic abstraction, not a merge of the inputs.`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      nodeType: { type: Type.STRING },
      name: { type: Type.STRING },
      summary: { type: Type.STRING },
      purpose: { type: Type.STRING },
      role: { type: Type.STRING },
      responsibilities: { type: Type.ARRAY, items: { type: Type.STRING } },
      technologies: { type: Type.ARRAY, items: { type: Type.STRING } },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
      entryPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      importantFiles: { type: Type.ARRAY, items: { type: Type.STRING } },
      publicInterfaces: { type: Type.ARRAY, items: { type: Type.STRING } },
      relatedComponents: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: [
      "nodeType",
      "name",
      "summary",
      "purpose",
      "role",
      "responsibilities",
      "technologies",
      "keywords",
      "entryPoints",
      "importantFiles",
      "publicInterfaces",
      "relatedComponents"
    ],
  };

  const prompt = `Module name: ${moduleName}\n\nFile summaries in this module:\n${JSON.stringify(fileSummaries, null, 2)}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  return llm.generateStructured<ComponentSummary>(messages, schema);
}

// ---------------------------------------------------------------- Stage 5

export async function generateArchitectureSummary(
  componentSummaries: ComponentSummary[],
  llm: LLMService,
): Promise<ArchitectureSummary> {
  const system = `You write a single JSON architecture summary for a repository, describing it as a system. ${QUALITY_RULES}\nYou are given ONLY component summaries, never source code or file summaries. Do not repeat component summaries verbatim — explain how they fit together.`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      nodeType: { type: Type.STRING },
      summary: { type: Type.STRING },
      architectureStyle: { type: Type.STRING },
      majorLayers: { type: Type.ARRAY, items: { type: Type.STRING } },
      requestFlows: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Describe the major request lifecycle through the application." },
      dataFlows: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Describe how important data moves through the system." },
      majorComponents: { type: Type.ARRAY, items: { type: Type.STRING } },
      crossCuttingConcerns: { type: Type.ARRAY, items: { type: Type.STRING } },
      technologies: { type: Type.ARRAY, items: { type: Type.STRING } },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: [
      "nodeType",
      "summary",
      "architectureStyle",
      "majorLayers",
      "requestFlows",
      "dataFlows",
      "majorComponents",
      "crossCuttingConcerns",
      "technologies",
      "keywords"
    ],
  };

  const prompt = `Component summaries:\n${JSON.stringify(componentSummaries, null, 2)}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  return llm.generateStructured<ArchitectureSummary>(messages, schema);
}

// ---------------------------------------------------------------- Stage 6

export async function generateRepositorySummary(
  architectureSummary: ArchitectureSummary,
  componentSummaries: ComponentSummary[],
  readme: string | null,
  packageMetadata: Record<string, unknown> | null,
  llm: LLMService,
): Promise<RepositorySummary> {
  const system = `You write a single JSON repository summary, describing the project to someone seeing it for the first time. ${QUALITY_RULES}`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      nodeType: { type: Type.STRING },
      summary: { type: Type.STRING },
      purpose: { type: Type.STRING, description: "Exactly one sentence" },
      features: { type: Type.ARRAY, items: { type: Type.STRING } },
      techStack: { type: Type.ARRAY, items: { type: Type.STRING } },
      interestingDesignDecisions: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING }, 
        description: "Only include architectural decisions that distinguish the project. Examples: Redis caching, CQRS, Background jobs, Event-driven architecture, Incremental indexing, Repository pattern." 
      },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: [
      "nodeType",
      "summary",
      "purpose",
      "features",
      "techStack",
      "interestingDesignDecisions",
      "keywords"
    ],
  };

  const prompt = `Architecture summary:\n${JSON.stringify(architectureSummary, null, 2)}\n\nComponent summaries:\n${JSON.stringify(componentSummaries, null, 2)}\n\nREADME:\n${readme ?? "(none found)"}\n\nPackage metadata:\n${JSON.stringify(packageMetadata ?? {}, null, 2)}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  return llm.generateStructured<RepositorySummary>(messages, schema);
}