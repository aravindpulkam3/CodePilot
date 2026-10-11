import { test } from "node:test";
import assert from "node:assert/strict";
import { RelationshipIndexingService } from "./relationshipIndexing.service.js";
import { extractLocalImports } from "../../shared/utils/importResolver.js";

// In-memory SQL boundary exercises the real extraction and graph-write sequence.
function fixture() {
  let rows: Array<{ source_path: string; target: string; resolved: boolean }> = [];
  const paths = new Set(["service.ts", "utils.ts", "other.ts"]);
  const db = { async query(sql: string, values: any[] = []) {
    if (sql.includes("SELECT source_path")) return { rows: rows.filter(r => !r.resolved) };
    if (sql.includes("SELECT DISTINCT file_path")) return { rows: [...paths].map(file_path => ({ file_path })) };
    if (sql.includes("INSERT INTO")) {
      for (let i = 0; i < values.length; i += 4) {
        const row = { source_path: values[i + 1], target: values[i + 2], resolved: values[i + 3] };
        if (!rows.some(r => JSON.stringify(r) === JSON.stringify(row))) rows.push(row);
      }
    } else if (sql.includes("DELETE FROM")) {
      if (sql.includes("ANY")) rows = rows.filter(r => !(r.resolved && values[1].includes(r.source_path)));
      else rows = rows.filter(r => !(r.source_path === values[1] || (sql.includes("target =") && r.resolved && r.target === values[1])));
    } else throw new Error("Unexpected SQL: " + sql);
    return { rows: [] };
  } };
  const service = new RelationshipIndexingService(db as any);
  return { seed: (legacy: typeof rows) => { rows = legacy; }, service, paths, edges: () => rows.filter(r => r.resolved),
    index: (source: string, specs: string[]) => service.indexFileRelationships("repo", source, extractLocalImports(source, specs, paths)) };
}

for (const scenario of ["stale", "updated", "replacement", "extension", "unchanged"]) {
  test("rename relationship correctness: " + scenario, async () => {
    const f = fixture();
    await f.index("service.ts", ["./utils", "./other"]);
    if (scenario !== "unchanged") {
      f.paths.delete("utils.ts");
      const renamed = scenario === "extension" ? "utils.js" : "helpers.ts";
      f.paths.add(renamed);
      await f.service.renameFileRelationships("repo", "utils.ts", renamed);
      if (scenario === "updated") await f.index("service.ts", ["./helpers", "./other"]);
      if (scenario === "replacement") f.paths.add("utils/index.ts");
    }
    await f.service.resolvePendingImports("repo");
    const expected = { stale: [], updated: ["helpers.ts"], replacement: ["utils/index.ts"], extension: ["utils.js"], unchanged: ["utils.ts"] }[scenario]!;
    assert.deepEqual(f.edges().map(r => r.target).sort(), ["other.ts", ...expected].sort());
    // Raw spellings survive finalization and repeated resolution is idempotent.
    await f.service.resolvePendingImports("repo");
    assert.deepEqual(f.edges().map(r => r.target).sort(), ["other.ts", ...expected].sort());
  });
}

test("re-resolving legacy pending imports preserves unrelated verified edges", async () => {
  const f = fixture();
  f.seed([{ source_path: "service.ts", target: "other.ts", resolved: true },
    { source_path: "service.ts", target: "./utils", resolved: false }]);
  await f.service.resolvePendingImports("repo");
  assert.deepEqual(f.edges().map(r => r.target).sort(), ["other.ts", "utils.ts"]);
});
