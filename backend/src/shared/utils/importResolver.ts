import path from "path";

/**
 * Best-effort resolution of a relative import specifier to a repo-relative
 * file path, so the import graph only contains edges between files that
 * actually exist in this repo (external packages are dropped).
 */
export function resolveLocalImport(fromFile: string, specifier: string, knownPaths: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null; // not a relative import -> external package

  // Drop a trailing .js/.jsx BEFORE building the base path. Under ESM/NodeNext
  // (which this backend itself uses), a TypeScript file is imported by the
  // extension it *compiles to*: `import x from "./auth.service.js"` refers to
  // auth.service.ts on disk. Without this, base keeps the ".js" and every
  // candidate below becomes "auth.service.js.ts", "auth.service.js.tsx", ...,
  // none of which exist — so the edge was silently dropped and the import
  // graph lost most of its internal TS->TS edges. Stripping here makes
  // "./auth.service" and "./auth.service.js" resolve identically.
  const strippedSpecifier = specifier.replace(/\.(jsx|js)$/, "");

  // Normalizing paths (using posix to maintain forward slashes for repo-relative paths)
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), strippedSpecifier));

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.js`,
    `${base}.py`,
    `${base}.go`,
  ];
  
  return candidates.find((c) => knownPaths.has(c)) ?? null;
}

/**
 * Extract distinct local imports from a file's AST metadata.
 * Optionally return them with their full specifier.
 */
export function extractLocalImports(
  fromFile: string,
  rawImports: string[],
  knownPaths: Set<string>
): { resolvedPath: string; specifier: string }[] {
  const edges = new Map<string, string>();
  for (const imp of rawImports) {
    const resolved = resolveLocalImport(fromFile, imp, knownPaths);
    if (resolved && !edges.has(resolved)) {
      edges.set(resolved, imp);
    }
  }
  return Array.from(edges.entries()).map(([resolvedPath, specifier]) => ({
    resolvedPath,
    specifier
  }));
}
