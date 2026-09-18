/**
 * Pure, DB-free building blocks for the deterministic repository and module
 * profiles (see repositoryMap.service.ts). Every line a profile renders is a
 * label followed by values copied from a file, a column, or a count — no
 * generated prose.
 *
 * Kept import-free apart from capBody so it can be unit-tested without a
 * database, the same split as interviewFocusResolution.ts / interview.service.ts.
 */
import { capBody } from "../../shared/prompts/sourceRefs.js";

// ---------------------------------------------------------------- limits

export const REPOSITORY_PROFILE_LIMITS = {
  maxChars: 1200,
  purposeChars: 200,
  featureModules: 10,
  composeFiles: 2,
  servicesPerFile: 6,
  manifests: 3,
  dependenciesPerManifest: 10,
  scriptsPerManifest: 6,
  devToolingPerManifest: 5,
  bootstrapFiles: 5,
  mostReferencedFiles: 3,
};

export const MODULE_PROFILE_LIMITS = {
  maxChars: 800,
  files: 6,
  exportedSymbols: 10,
  importsFrom: 5,
  importedBy: 5,
};

export interface RenderedProfile {
  text: string;
  truncated: boolean;
}

/** "a, b, c" when complete; "a, b (2 of 7)" when capped, so a partial list never reads as the whole. */
function capped(items: string[], max: number): { list: string; countNote: string } {
  const shown = items.slice(0, max);
  return {
    list: shown.join(", "),
    countNote: items.length > shown.length ? `${shown.length} of ${items.length}` : "",
  };
}

function label(base: string, ...notes: string[]): string {
  const parts = notes.filter(Boolean);
  return parts.length ? `${base} (${parts.join(", ")})` : base;
}

function finish(lines: string[], maxChars: number): RenderedProfile {
  const { body, truncated } = capBody(lines.join("\n"), maxChars, { atLine: true });
  return { text: body, truncated };
}

// ---------------------------------------------------------------- manifests

export interface ParsedManifest {
  name: string | null;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
}

/** JSON.parse of a package.json. Returns null (never throws) for anything that isn't a JSON object. */
export function parsePackageManifest(text: string): ParsedManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
  return {
    name: typeof obj.name === "string" ? obj.name : null,
    dependencies: keysOf(obj.dependencies),
    devDependencies: keysOf(obj.devDependencies).filter((d) => !d.startsWith("@types/")),
    scripts: keysOf(obj.scripts),
  };
}

export interface ComposeService {
  name: string;
  image: string | null;
}

/**
 * Service names (and images) under the top-level `services:` key of a
 * docker-compose file. A bounded structure scan, not a YAML parser: it reads
 * exactly one shape — block-style direct children of a column-0 `services:`.
 * Any other shape (flow style, no `services:` key) returns [] — the failure
 * mode is omission, never a wrong service name.
 */
export function parseComposeServices(text: string): ComposeService[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.replace(/\s+#.*$/, "").trimEnd() === "services:");
  if (start < 0) return [];

  const services: ComposeService[] = [];
  let childIndent: number | null = null;
  let grandIndent: number | null = null;
  let current: ComposeService | null = null;

  for (const raw of lines.slice(start + 1)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break; // next top-level key ends the block
    if (childIndent === null) childIndent = indent;
    if (indent < childIndent) break; // inconsistent indentation: stop rather than guess

    if (indent === childIndent) {
      const m = /^("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+)):\s*(#.*)?$/.exec(trimmed);
      current = m ? { name: m[2] ?? m[3] ?? m[4], image: null } : null;
      if (current) services.push(current);
      grandIndent = null;
      continue;
    }

    if (!current) continue;
    if (grandIndent === null) grandIndent = indent;
    if (indent === grandIndent && current.image === null) {
      const m = /^image:\s*["']?([^"'\s#]+)/.exec(trimmed);
      if (m) current.image = m[1];
    }
  }
  return services;
}

// ---------------------------------------------------------------- README / bootstrap

/**
 * First paragraph of a README section, skipping headings, badges, images and
 * HTML (lines starting with #, ![, [![ or <). Capped at a word boundary.
 */
export function extractReadmePurpose(readmeText: string, maxChars = REPOSITORY_PROFILE_LIMITS.purposeChars): string | null {
  const paragraph: string[] = [];
  for (const line of readmeText.replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    const skippable = t === "" || /^(#|!\[|\[!\[|<)/.test(t);
    if (skippable) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(t);
  }
  if (paragraph.length === 0) return null;
  const text = paragraph.join(" ");
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const BOOTSTRAP_BASENAME = /^(server|worker|main|app)\.(ts|tsx|js|jsx|py|go|cpp)$/i;

/**
 * Entry-point candidates from a FIXED basename list — not detection. Bare
 * index.* is excluded on purpose: feature barrels like features/auth/index.ts
 * are not entry points. Import fan-in is never used here; entry points are
 * typically imported by nothing.
 */
export function selectBootstrapFiles(indexedPaths: string[]): string[] {
  return indexedPaths
    .filter((p) => {
      const base = p.slice(p.lastIndexOf("/") + 1);
      return BOOTSTRAP_BASENAME.test(base) || base === "manage.py";
    })
    .sort();
}

// ---------------------------------------------------------------- repository profile

export interface ModuleCount {
  module: string;
  fileCount: number;
}

export interface RepositoryProfileFacts {
  purpose: string | null;
  featureModules: ModuleCount[];
  infrastructureModules: ModuleCount[];
  composeFiles: { filePath: string; services: ComposeService[] }[];
  manifests: { filePath: string; manifest: ParsedManifest }[];
  bootstrapFiles: string[];
  /** Import fan-in per file; only files with fan-in > 0. */
  mostReferencedFiles: { path: string; count: number }[];
}

const byCountThenName = (a: ModuleCount, b: ModuleCount) => b.fileCount - a.fileCount || a.module.localeCompare(b.module);
const byDepthThenPath = (a: { filePath: string }, b: { filePath: string }) =>
  a.filePath.split("/").length - b.filePath.split("/").length || a.filePath.localeCompare(b.filePath);

/**
 * Renders in PRIORITY order, so if the hard cap bites it removes the least
 * useful lines first: purpose → feature modules → runtime services →
 * dependencies → scripts → dev tooling → bootstrap files → shared/infra
 * modules → most referenced files.
 */
export function renderRepositoryProfile(facts: RepositoryProfileFacts): RenderedProfile {
  const L = REPOSITORY_PROFILE_LIMITS;
  const lines: string[] = [];

  if (facts.purpose) lines.push(`Purpose: ${facts.purpose}`);

  const features = [...facts.featureModules].sort(byCountThenName);
  if (features.length > 0) {
    const c = capped(features.map((m) => `${m.module} (${m.fileCount})`), L.featureModules);
    lines.push(`${label("Feature modules", c.countNote, "by file count")}: ${c.list}`);
  }

  for (const compose of [...facts.composeFiles].sort(byDepthThenPath).slice(0, L.composeFiles)) {
    if (compose.services.length === 0) continue;
    const c = capped(compose.services.map((s) => (s.image ? `${s.name} (${s.image})` : s.name)), L.servicesPerFile);
    lines.push(`${label(`Runtime services`, compose.filePath, c.countNote)}: ${c.list}`);
  }

  const manifests = [...facts.manifests].sort(byDepthThenPath).slice(0, L.manifests);
  for (const { filePath, manifest } of manifests) {
    if (manifest.dependencies.length === 0) continue;
    const c = capped(manifest.dependencies, L.dependenciesPerManifest);
    lines.push(`${label("Dependencies", filePath, c.countNote)}: ${c.list}`);
  }
  for (const { filePath, manifest } of manifests) {
    if (manifest.scripts.length === 0) continue;
    const c = capped(manifest.scripts, L.scriptsPerManifest);
    lines.push(`${label("Scripts", filePath, c.countNote)}: ${c.list}`);
  }
  for (const { filePath, manifest } of manifests) {
    if (manifest.devDependencies.length === 0) continue;
    const c = capped(manifest.devDependencies, L.devToolingPerManifest);
    lines.push(`${label("Dev tooling", filePath, c.countNote)}: ${c.list}`);
  }

  if (facts.bootstrapFiles.length > 0) {
    const c = capped(facts.bootstrapFiles, L.bootstrapFiles);
    lines.push(`${label("Bootstrap files", c.countNote)}: ${c.list}`);
  }

  const infra = [...facts.infrastructureModules].sort(byCountThenName);
  if (infra.length > 0) {
    lines.push(`Shared/infrastructure modules: ${infra.map((m) => `${m.module} (${m.fileCount})`).join(", ")}`);
  }

  const referenced = [...facts.mostReferencedFiles].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  if (referenced.length > 0) {
    const c = capped(referenced.map((r) => `${r.path} (imported by ${r.count})`), L.mostReferencedFiles);
    lines.push(`${label("Most referenced files", c.countNote)}: ${c.list}`);
  }

  return finish(lines, L.maxChars);
}

// ---------------------------------------------------------------- module profile

export interface ModuleProfileFacts {
  module: string;
  files: { path: string; fanIn: number }[];
  /** Distinct qualified names of exported top-level symbols, in file order. */
  exportedSymbols: string[];
  importsFrom: { module: string; edges: number }[];
  importedBy: { module: string; edges: number }[];
}

const byEdges = (a: { module: string; edges: number }, b: { module: string; edges: number }) =>
  b.edges - a.edges || a.module.localeCompare(b.module);

export function renderModuleProfile(facts: ModuleProfileFacts): RenderedProfile {
  const L = MODULE_PROFILE_LIMITS;
  const lines: string[] = [`Module: ${facts.module} (${facts.files.length} file${facts.files.length === 1 ? "" : "s"})`];

  const files = [...facts.files].sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path));
  if (files.length > 0) {
    const c = capped(files.map((f) => f.path), L.files);
    lines.push(`${label("Files", c.countNote, "by import fan-in")}: ${c.list}`);
  }
  if (facts.exportedSymbols.length > 0) {
    const c = capped(facts.exportedSymbols, L.exportedSymbols);
    lines.push(`${label("Exported symbols", c.countNote)}: ${c.list}`);
  }
  if (facts.importsFrom.length > 0) {
    const c = capped([...facts.importsFrom].sort(byEdges).map((m) => m.module), L.importsFrom);
    lines.push(`${label("Imports from", c.countNote)}: ${c.list}`);
  }
  if (facts.importedBy.length > 0) {
    const c = capped([...facts.importedBy].sort(byEdges).map((m) => m.module), L.importedBy);
    lines.push(`${label("Imported by", c.countNote)}: ${c.list}`);
  }

  return finish(lines, L.maxChars);
}
