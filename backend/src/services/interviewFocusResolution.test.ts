import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePathAgainstList,
  resolveModuleAgainstList,
  checkActionFocusConsistency,
  granularityOf,
} from "./interviewFocusResolution.js";
import type { InterviewFocus } from "../types/interviewTypes.js";

describe("resolvePathAgainstList", () => {
  const contextPaths = ["backend/src/services/auth.service.ts"];
  const indexedPaths = [
    "backend/src/services/auth.service.ts",
    "backend/src/utils/jwt.ts",
    "backend/src/utils/hash.ts",
    "frontend/src/utils/format.ts",
  ];

  test("absent/empty path is a legitimate no-target declaration, not a rejection", () => {
    assert.deepEqual(resolvePathAgainstList(undefined, contextPaths, indexedPaths), {
      resolvedPath: null,
      rejected: false,
    });
    assert.deepEqual(resolvePathAgainstList("  ", contextPaths, indexedPaths), {
      resolvedPath: null,
      rejected: false,
    });
  });

  test("exact match against this turn's shown context wins first", () => {
    assert.deepEqual(
      resolvePathAgainstList("backend/src/services/auth.service.ts", contextPaths, indexedPaths),
      { resolvedPath: "backend/src/services/auth.service.ts", rejected: false },
    );
  });

  test("exact match against the full indexed list, even when not in this turn's context", () => {
    assert.deepEqual(resolvePathAgainstList("backend/src/utils/jwt.ts", contextPaths, indexedPaths), {
      resolvedPath: "backend/src/utils/jwt.ts",
      rejected: false,
    });
  });

  test("unique basename match resolves to the real full path", () => {
    assert.deepEqual(resolvePathAgainstList("jwt.ts", contextPaths, indexedPaths), {
      resolvedPath: "backend/src/utils/jwt.ts",
      rejected: false,
    });
  });

  test("ambiguous basename is rejected, not guessed", () => {
    const ambiguous = [...indexedPaths, "backend/src/other/format.ts"];
    assert.deepEqual(resolvePathAgainstList("format.ts", contextPaths, ambiguous), {
      resolvedPath: null,
      rejected: true,
    });
  });

  test("no match anywhere is rejected", () => {
    assert.deepEqual(resolvePathAgainstList("backend/src/does/not/exist.ts", contextPaths, indexedPaths), {
      resolvedPath: null,
      rejected: true,
    });
  });
});

describe("resolveModuleAgainstList", () => {
  const contextModules = ["Auth"];
  const allModules = ["Auth", "Utilities", "Configuration"];

  test("absent/empty module is a legitimate repository/no-narrowing declaration, not a rejection", () => {
    assert.deepEqual(resolveModuleAgainstList(undefined, contextModules, allModules), {
      resolvedModule: null,
      rejected: false,
    });
  });

  test("exact match against this turn's shown module context wins first", () => {
    assert.deepEqual(resolveModuleAgainstList("Auth", contextModules, allModules), {
      resolvedModule: "Auth",
      rejected: false,
    });
  });

  test("exact match against the full module inventory even when not shown this turn", () => {
    assert.deepEqual(resolveModuleAgainstList("Utilities", contextModules, allModules), {
      resolvedModule: "Utilities",
      rejected: false,
    });
  });

  test("case-insensitive/trimmed match is forgiven, unlike a file path", () => {
    assert.deepEqual(resolveModuleAgainstList(" utilities ", contextModules, allModules), {
      resolvedModule: "Utilities",
      rejected: false,
    });
  });

  test("a close synonym is rejected, not fuzzy-matched", () => {
    assert.deepEqual(resolveModuleAgainstList("Authentication", contextModules, allModules), {
      resolvedModule: null,
      rejected: true,
    });
  });
});

describe("checkActionFocusConsistency", () => {
  const authFile: InterviewFocus = { filePath: "backend/src/services/auth.service.ts", symbolName: null, module: "Auth" };
  const authModuleOnly: InterviewFocus = { filePath: null, symbolName: null, module: "Auth" };
  const utilFile: InterviewFocus = { filePath: "backend/src/utils/jwt.ts", symbolName: null, module: "Utilities" };
  const utilModuleOnly: InterviewFocus = { filePath: null, symbolName: null, module: "Utilities" };
  const repositoryScope: InterviewFocus = { filePath: null, symbolName: null, module: null };

  test("stay-action cross-module jump is rejected: previous module kept, filePath dropped", () => {
    const result = checkActionFocusConsistency("FOLLOW_UP", utilFile, authFile);
    assert.deepEqual(result, {
      focus: { filePath: null, symbolName: null, module: "Auth" },
      moduleJumpRejected: true,
    });
  });

  test("stay-action cross-module jump rejected the same way for DEEP_DIVE and SIMPLIFY", () => {
    assert.equal(checkActionFocusConsistency("DEEP_DIVE", utilModuleOnly, authFile).moduleJumpRejected, true);
    assert.equal(checkActionFocusConsistency("SIMPLIFY", utilModuleOnly, authFile).moduleJumpRejected, true);
  });

  test("stay-action narrowing within the same module (module -> file) is accepted", () => {
    const result = checkActionFocusConsistency("DEEP_DIVE", authFile, authModuleOnly);
    assert.deepEqual(result, { focus: authFile, moduleJumpRejected: false });
  });

  test("stay-action de-escalation (file -> its own module) is accepted", () => {
    const result = checkActionFocusConsistency("SIMPLIFY", authModuleOnly, authFile);
    assert.deepEqual(result, { focus: authModuleOnly, moduleJumpRejected: false });
  });

  test("stay-action de-escalation to REPOSITORY scope is accepted (no module to conflict with)", () => {
    const result = checkActionFocusConsistency("FOLLOW_UP", repositoryScope, authFile);
    assert.deepEqual(result, { focus: repositoryScope, moduleJumpRejected: false });
  });

  test("first commit from REPOSITORY scope into a module is accepted (no previous module to jump from)", () => {
    const result = checkActionFocusConsistency("DEEP_DIVE", authModuleOnly, repositoryScope);
    assert.deepEqual(result, { focus: authModuleOnly, moduleJumpRejected: false });
  });

  test("NEW_TOPIC is never rejected by this check, regardless of target", () => {
    const result = checkActionFocusConsistency("NEW_TOPIC", utilFile, authFile);
    assert.deepEqual(result, { focus: utilFile, moduleJumpRejected: false });
  });
});

describe("granularityOf", () => {
  test("a set filePath is FILE granularity, regardless of module", () => {
    assert.equal(granularityOf({ filePath: "a.ts", symbolName: null, module: "Auth" }), "FILE");
  });

  test("no filePath but a set module is MODULE granularity", () => {
    assert.equal(granularityOf({ filePath: null, symbolName: null, module: "Auth" }), "MODULE");
  });

  test("neither filePath nor module is REPOSITORY granularity", () => {
    assert.equal(granularityOf({ filePath: null, symbolName: null, module: null }), "REPOSITORY");
  });
});
