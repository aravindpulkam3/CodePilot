import path from "path";

/**
 * Best-effort resolution of a relative import specifier to a repo-relative
 * file path, so the import graph only contains edges between files that
 * actually exist in this repo (external packages are dropped).
 */
//It translates "../utils/auth.js" written inside src/controllers/userController.ts into the exact real file path on disk: "src/utils/auth.ts".
export function resolveLocalImport(
  fromFile: string,
  specifier: string,
  knownPaths: Set<string>,
): string | null {
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
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), strippedSpecifier),
  );

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
 * One import of a file. `resolvedPath: null` means PENDING: a relative
 * specifier that matched no known path yet. That happens legitimately on an
 * initial index, where knownPaths only covers files committed so far plus
 * the current 50-file chunk; the target may be in a later chunk.
 * RelationshipIndexingService#resolvePendingImports re-resolves these once
 * every chunk has committed.
 */
export interface LocalImport {
  resolvedPath: string | null;
  specifier: string;
}

/**
 * Extract distinct local imports from a file's AST metadata: resolved edges
 * (deduped by target path, first specifier wins) plus unresolved RELATIVE
 * specifiers (deduped by specifier). Non-relative specifiers — packages and
 * path aliases like "@/lib/x" — are dropped, since they can never resolve.
 */
export function extractLocalImports(
  fromFile: string,
  rawImports: string[],
  knownPaths: Set<string>,
): LocalImport[] {
  const edges = new Map<string, string>();
  const pending = new Set<string>();
  for (const imp of rawImports) {
    const resolved = resolveLocalImport(fromFile, imp, knownPaths);
    if (resolved) {
      if (!edges.has(resolved)) edges.set(resolved, imp);
    } else if (imp.startsWith(".")) {
      pending.add(imp);
    }
  }
  return [
    ...Array.from(edges.entries()).map(([resolvedPath, specifier]) => ({ resolvedPath, specifier })),
    ...Array.from(pending).map((specifier) => ({ resolvedPath: null, specifier })),
  ];
}
