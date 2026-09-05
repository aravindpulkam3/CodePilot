import path from "path";
import { Type, Schema } from "@google/genai";
import type { FileASTMetadata } from "../types/summaryTypes.js";
import { LLMService, LLMMessage } from "./llm.service.js";
import { resolveLocalImport } from "../utils/importResolver.js";

// Folders that describe *layers*, not *features* — grouping purely by these
// names produces a "controllers" module and a "services" module instead of
// an "Authentication" module, which is the opposite of what we want. They
// get treated specially: their files are re-clustered by feature-name
// (derived from the filename) rather than by directory.
const LAYER_FOLDER_NAMES = new Set([
  "controllers",
  "services",
  "repositories",
  "routes",
  "handlers",
  "middleware",
  "middlewares",
]);

// Folders that are almost always genuinely cross-cutting rather than a
// feature module — force these into a fixed module name instead of letting
// directory clustering fragment them (e.g. "utils/date.ts" and
// "utils/string.ts" should not become two different modules).
const INFRA_FOLDER_MAP: Record<string, string> = {
  utils: "Utilities",
  util: "Utilities",
  lib: "Utilities",
  common: "Shared",
  shared: "Shared",
  types: "Shared Types",
  config: "Configuration",
  configs: "Configuration",
  constants: "Configuration",
};

export interface ModuleAssignment {
  filePath: string;
  module: string;
}

function directorySegments(filePath: string): string[] {
  // path.posix, not path.sep: repo-relative paths always use "/", but on
  // Windows path.sep is "\", which made the whole dirname collapse into one
  // segment and silently disabled the infra/layer grouping below (modules
  // stayed distinct, since the collapsed string was still unique per
  // directory, but labels degraded to e.g. "Backend/Src/Services" instead of
  // "Utilities"). importResolver.ts:12 already uses path.posix for the same
  // reason.
  return path.posix.dirname(filePath).split(path.posix.sep).filter((s) => s && s !== ".");
}

// Strips common layer suffixes so "auth.controller.ts" and
// "auth.service.ts" both resolve to feature name "auth".
function featureNameFromFile(filePath: string): string {
  const base = path.basename(filePath).replace(/\.(ts|tsx|js|jsx|py|go|cpp)$/, "");
  return base.replace(/\.(controller|service|repository|route|handler|middleware)$/i, "");
}

function toTitleCase(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function initialModuleFor(filePath: string): string {
  const segments = directorySegments(filePath);

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (INFRA_FOLDER_MAP[lower]) return INFRA_FOLDER_MAP[lower];
  }

  const lastSegment = segments[segments.length - 1]?.toLowerCase();
  if (lastSegment && LAYER_FOLDER_NAMES.has(lastSegment)) {
    return toTitleCase(featureNameFromFile(filePath));
  }

  // Default: the deepest meaningful directory segment, skipping generic
  // roots like "src"/"app" that carry no feature meaning on their own.
  const meaningful = segments.filter((s) => !["src", "app", "source"].includes(s.toLowerCase()));
  return toTitleCase(meaningful[meaningful.length - 1] ?? "Root");
}

function buildImportGraph(files: FileASTMetadata[]): Map<string, Set<string>> {
  const knownPaths = new Set(files.map((f) => f.filePath));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const edges = new Set<string>();
    for (const imp of file.imports) {
      const resolved = resolveLocalImport(file.filePath, imp, knownPaths);
      if (resolved) edges.add(resolved);
    }
    graph.set(file.filePath, edges);
  }
  return graph;
}

// If a small module's files import almost exclusively into one other
// module, fold it into that module. Deliberately conservative (majority
// threshold + minimum edge count) — the goal is fixing obvious
// over-fragmentation, not full graph clustering.
function mergeByImportDensity(
  assignments: Map<string, string>,
  importGraph: Map<string, Set<string>>,
): Map<string, string> {
  const moduleFiles = new Map<string, string[]>();
  for (const [file, mod] of assignments) {
    if (!moduleFiles.has(mod)) moduleFiles.set(mod, []);
    moduleFiles.get(mod)!.push(file);
  }

  const merged = new Map(assignments);

  for (const [mod, files] of moduleFiles) {
    if (files.length > 3) continue; // only reconsider small/fragmented modules

    const targetCounts = new Map<string, number>();
    let totalEdges = 0;
    for (const file of files) {
      for (const target of importGraph.get(file) ?? []) {
        const targetModule = assignments.get(target);
        if (!targetModule || targetModule === mod) continue;
        targetCounts.set(targetModule, (targetCounts.get(targetModule) ?? 0) + 1);
        totalEdges++;
      }
    }
    if (totalEdges < 2) continue;

    const [bestModule, bestCount] = [...targetCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (bestModule && bestCount / totalEdges > 0.6) {
      for (const file of files) merged.set(file, bestModule);
    }
  }

  return merged;
}

export function discoverModulesHeuristically(files: FileASTMetadata[]): ModuleAssignment[] {
  const importGraph = buildImportGraph(files);

  const initial = new Map<string, string>();
  for (const file of files) initial.set(file.filePath, initialModuleFor(file.filePath));

  const refined = mergeByImportDensity(initial, importGraph);

  return files.map((f) => ({ filePath: f.filePath, module: refined.get(f.filePath)! }));
}

// Optional second pass: ask an LLM to sanity-check / rename the heuristic
// clusters using directory shape + cross-module import counts as evidence.
// This runs before any file summaries exist, so it only ever sees
// structural signal (paths, import graph) — never source code or summaries.
export async function refineModulesWithLLM(
  assignments: ModuleAssignment[],
  files: FileASTMetadata[],
  llm: LLMService,
): Promise<ModuleAssignment[]> {
  const importGraph = buildImportGraph(files);
  const byModule = new Map<string, string[]>();
  for (const a of assignments) {
    if (!byModule.has(a.module)) byModule.set(a.module, []);
    byModule.get(a.module)!.push(a.filePath);
  }

  const crossModuleEdges: Record<string, number> = {};
  for (const [file, targets] of importGraph) {
    const fromModule = assignments.find((a) => a.filePath === file)?.module;
    for (const target of targets) {
      const toModule = assignments.find((a) => a.filePath === target)?.module;
      if (fromModule && toModule && fromModule !== toModule) {
        const key = `${fromModule} -> ${toModule}`;
        crossModuleEdges[key] = (crossModuleEdges[key] ?? 0) + 1;
      }
    }
  }

  const system =
    "You review heuristically-generated code module clusters for a repository. " +
    "You only ever see file paths and import relationships, never source code. " +
    "Propose corrected module names/merges where the clustering is obviously wrong " +
    "(e.g. a module with 1-2 files that clearly belongs elsewhere, or a generic name " +
    "that should reflect the actual feature). Keep modules you're not confident about unchanged.";

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      renames: {
        type: Type.OBJECT,
        description: "Mapping of old module names to new module names",
      },
    },
    required: ["renames"],
  };

  const prompt = JSON.stringify(
    {
      modules: Object.fromEntries(byModule),
      crossModuleImportCounts: crossModuleEdges,
    },
    null,
    2,
  );

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  try {
    const result = await llm.generateStructured<{ renames: Record<string, string> }>(messages, schema);
    return assignments.map((a) => ({
      filePath: a.filePath,
      module: result.renames?.[a.module] ?? a.module,
    }));
  } catch (error) {
    console.error("[Module Discovery] LLM refinement failed, keeping heuristic assignment:", error);
    return assignments;
  }
}