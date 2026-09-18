import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveLocalImport, extractLocalImports } from "./importResolver.js";

describe("resolveLocalImport", () => {
  test("resolves a .js-suffixed specifier to the .ts file on disk", () => {
    // The ESM/NodeNext convention this backend itself uses: a TypeScript file
    // is imported by the extension it COMPILES TO. Before the suffix was
    // stripped, the candidates were "auth.service.js", "auth.service.js.ts",
    // ... and the edge was silently dropped.
    const known = new Set(["src/services/auth.service.ts"]);
    const resolved = resolveLocalImport(
      "src/controllers/auth.controller.ts",
      "../services/auth.service.js",
      known,
    );
    assert.equal(resolved, "src/services/auth.service.ts");
  });

  test("an extension-less specifier resolves the same way", () => {
    const known = new Set(["src/services/auth.service.ts"]);
    const resolved = resolveLocalImport(
      "src/controllers/auth.controller.ts",
      "../services/auth.service",
      known,
    );
    assert.equal(resolved, "src/services/auth.service.ts");
  });

  test("both spellings converge on the identical path", () => {
    // The core of the bug: these two must not disagree, or the import graph
    // depends on which convention a file happens to use.
    const known = new Set(["src/config/env.ts"]);
    const withSuffix = resolveLocalImport("src/app.ts", "./config/env.js", known);
    const without = resolveLocalImport("src/app.ts", "./config/env", known);

    assert.equal(withSuffix, without);
    assert.equal(withSuffix, "src/config/env.ts");
  });

  test("resolves a .jsx specifier to a .tsx file", () => {
    const known = new Set(["src/components/Button.tsx"]);
    const resolved = resolveLocalImport("src/pages/Home.tsx", "../components/Button.jsx", known);
    assert.equal(resolved, "src/components/Button.tsx");
  });

  test("still resolves a directory index import", () => {
    const known = new Set(["src/auth/index.ts"]);
    assert.equal(resolveLocalImport("src/app.ts", "./auth", known), "src/auth/index.ts");
    assert.equal(resolveLocalImport("src/app.ts", "./auth.js", known), "src/auth/index.ts");
  });

  test("still resolves a genuine .js file when that is what exists", () => {
    // Stripping the suffix must not break a real JavaScript target — the
    // candidate list re-appends .js.
    const known = new Set(["src/legacy/helper.js"]);
    assert.equal(
      resolveLocalImport("src/app.ts", "./legacy/helper.js", known),
      "src/legacy/helper.js",
    );
  });

  test("returns null for a non-relative specifier (external package)", () => {
    const known = new Set(["src/express.ts"]);
    assert.equal(resolveLocalImport("src/app.ts", "express", known), null);
    // Path aliases are non-relative too, and are still out of scope.
    assert.equal(resolveLocalImport("src/app.ts", "@/lib/x", known), null);
  });

  test("returns null when nothing in the repo matches", () => {
    const known = new Set(["src/services/auth.service.ts"]);
    assert.equal(resolveLocalImport("src/app.ts", "./does-not-exist.js", known), null);
  });
});

describe("extractLocalImports", () => {
  test("carries the fix through the wrapper and dedupes by resolved path", () => {
    const known = new Set(["src/services/auth.service.ts", "src/config/env.ts"]);
    const edges = extractLocalImports(
      "src/controllers/auth.controller.ts",
      [
        "../services/auth.service.js",
        "../services/auth.service", // same target, different spelling
        "../config/env.js",
        "express", // external, dropped
      ],
      known,
    );

    const targets = edges.map((e) => e.resolvedPath).sort();
    assert.deepEqual(targets, ["src/config/env.ts", "src/services/auth.service.ts"]);
    // The first spelling seen wins as the recorded specifier.
    assert.equal(
      edges.find((e) => e.resolvedPath === "src/services/auth.service.ts")?.specifier,
      "../services/auth.service.js",
    );
  });

  test("returns an unresolved RELATIVE specifier as pending (resolvedPath null)", () => {
    // Initial indexing: the target lives in a later 50-file chunk, so it is not
    // a known path yet. It must be recorded, not silently dropped, so the
    // finalize pass can resolve it once every chunk has committed.
    const known = new Set(["src/config/env.ts"]);
    const edges = extractLocalImports(
      "src/app.ts",
      ["./config/env.js", "./features/sync/repositorySync.service.js"],
      known,
    );

    assert.deepEqual(edges, [
      { resolvedPath: "src/config/env.ts", specifier: "./config/env.js" },
      { resolvedPath: null, specifier: "./features/sync/repositorySync.service.js" },
    ]);
  });

  test("still drops non-relative specifiers: packages and path aliases never resolve", () => {
    const edges = extractLocalImports("src/app.ts", ["express", "@/lib/x", "node:path"], new Set());
    assert.deepEqual(edges, []);
  });

  test("dedupes pending specifiers by exact specifier", () => {
    const edges = extractLocalImports("src/app.ts", ["./missing.js", "./missing.js", "../other"], new Set());
    assert.deepEqual(
      edges.map((e) => e.specifier),
      ["./missing.js", "../other"],
    );
    assert.ok(edges.every((e) => e.resolvedPath === null));
  });
});
