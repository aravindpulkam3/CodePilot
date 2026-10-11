import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const state = { legacy: true, fullReads: 0, jobs: 0, invalidated: false, cleared: false };
(globalThis as any).__syncCorrectness = {
  state,
  pool: { async query(sql: string) {
    if (sql.includes("RETURNING r.*")) return { rows: [{ source_type: "public", owner: "o", name: "r", last_indexed_sha: "same", indexing_target_sha: "same", index_chunks_total: null }] };
    if (sql.includes("RETURNING indexing_target_sha")) return { rows: [{ indexing_target_sha: "same" }] };
    if (sql.includes("SELECT 1 FROM repository_embeddings")) return { rows: state.legacy ? [{}] : [] };
    if (sql.includes("last_indexed_sha = NULL")) state.invalidated = true;
    if (sql.includes("cleared AS")) state.cleared = true;
    return { rows: [], rowCount: 1 };
  } },
};
const mocks: Record<string, string> = {
  "../../config/db.js": "export const pool = globalThis.__syncCorrectness.pool;",
  "../../infrastructure/github/github.service.js": "export async function fetchAllRepositoryFiles(){globalThis.__syncCorrectness.state.fullReads++; return [{path:'schema.sql',content:'CREATE TABLE t(id int)',status:'added'}]}",
  "./repositoryIndex.service.js": "export const isIndexableFile = () => true;",
  "../../config/queues.js": "export const syncQueue={};export const indexQueue={add:async()=>{globalThis.__syncCorrectness.state.jobs++}};",
  "../../shared/events/eventEmitter.js": "export const appEvents={emit(){}};export const EVENT_TYPES={REPOSITORY_SYNCED:'synced'};",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  return mocks[specifier] ? { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true } : next(specifier, context);
} });
const { repositorySyncService } = await import("./repositorySync.service.js");
hooks.deregister();
after(() => { delete (globalThis as any).__syncCorrectness; });

test("equal-SHA legacy docs rebuild through existing sync jobs; corrected docs skip", async () => {
  await repositorySyncService.processSyncJob("user", "repo", "new-run");
  assert.equal(state.invalidated, true);
  assert.equal(state.cleared, true);
  assert.equal(state.fullReads, 1);
  assert.equal(state.jobs, 1);
  Object.assign(state, { legacy: false, fullReads: 0, jobs: 0, invalidated: false, cleared: false });
  await repositorySyncService.processSyncJob("user", "repo", "next-run");
  assert.equal(state.invalidated, false);
  assert.equal(state.fullReads, 0);
  assert.equal(state.jobs, 0);
});
