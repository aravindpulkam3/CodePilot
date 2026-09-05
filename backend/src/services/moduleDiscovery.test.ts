import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { initialModuleFor } from "./moduleDiscovery.service.js";

describe("initialModuleFor", () => {
  test("groups infra folders by their fixed name, on posix paths", () => {
    // Before the path.posix fix, directorySegments split on path.sep (\ on
    // Windows), so the whole dirname collapsed into one segment and this
    // grouping never fired — modules stayed distinct but labels degraded to
    // e.g. "Backend/Src/Utils" instead of "Utilities". Interview's coverage
    // tracking depends on this grouping being meaningful, not just distinct.
    assert.equal(initialModuleFor("backend/src/utils/date.ts"), "Utilities");
    assert.equal(initialModuleFor("backend/src/lib/hash.ts"), "Utilities");
    assert.equal(initialModuleFor("backend/src/config/env.ts"), "Configuration");
    assert.equal(initialModuleFor("backend/src/types/summaryTypes.ts"), "Shared Types");
  });

  test("re-clusters layer folders by feature name, not by layer", () => {
    // "services/auth.service.ts" and "controllers/auth.controller.ts" should
    // both resolve to the "Auth" feature, not to a generic "Services" /
    // "Controllers" module.
    assert.equal(initialModuleFor("backend/src/services/auth.service.ts"), "Auth");
    assert.equal(initialModuleFor("backend/src/controllers/auth.controller.ts"), "Auth");
  });

  test("falls back to the deepest meaningful directory segment", () => {
    assert.equal(initialModuleFor("backend/src/modules/chat/chat.service.ts"), "Chat");
  });

  test("skips generic root segments (src/app/source)", () => {
    assert.equal(initialModuleFor("src/foo/bar.ts"), "Foo");
    assert.equal(initialModuleFor("app/widgets/x.ts"), "Widgets");
  });

  test("a file directly under the repo root falls back to Root", () => {
    assert.equal(initialModuleFor("README.md"), "Root");
  });
});
