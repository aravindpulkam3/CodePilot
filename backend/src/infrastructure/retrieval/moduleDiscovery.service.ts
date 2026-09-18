import path from "path";

/**
 * Deterministic module identity from a file path. Used by Interview's module
 * inventory / coverage and by the repository and module profiles
 * (repositoryMap.service.ts). No LLM, no graph, no persisted state.
 */

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

/**
 * Module names initialModuleFor assigns to cross-cutting folders. The
 * repository profile uses this to list these separately from feature
 * modules: a shared/config bucket is often the largest module by file count
 * and by import fan-in, without being the most architecturally important.
 */
export const INFRASTRUCTURE_MODULE_NAMES: ReadonlySet<string> = new Set(Object.values(INFRA_FOLDER_MAP));

function directorySegments(filePath: string): string[] {
  // path.posix, not path.sep: repo-relative paths always use "/", but on
  // Windows path.sep is "\", which made the whole dirname collapse into one
  // segment and silently disabled the infra/layer grouping below (modules
  // stayed distinct, since the collapsed string was still unique per
  // directory, but labels degraded to e.g. "Backend/Src/Services" instead of
  // "Utilities"). importResolver.ts already uses path.posix for the same
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
