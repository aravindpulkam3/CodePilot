import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractReadmePurpose,
  MODULE_PROFILE_LIMITS,
  parseComposeServices,
  parsePackageManifest,
  renderModuleProfile,
  renderRepositoryProfile,
  REPOSITORY_PROFILE_LIMITS,
  selectBootstrapFiles,
  type RepositoryProfileFacts,
} from "./repositoryProfileFacts.js";

// backend/docker-compose.yml from this repository, byte-for-byte shape
// (CRLF line endings, blank lines inside services, 4-space comments).
const CODEPILOT_COMPOSE = [
  "services:",
  "  postgres:",
  "    image: pgvector/pgvector:pg17",
  "",
  "    container_name: ai-workspace-db",
  "",
  "    restart: unless-stopped",
  "",
  "    environment:",
  "      POSTGRES_DB: ai_workspace",
  "      POSTGRES_USER: postgres",
  "",
  "    ports:",
  '      - "5432:5432"',
  "",
  "  redis-cache:",
  "    image: redis:7-alpine",
  "    container_name: codepilot_redis_cache",
  "    # No persistence, allkeys-lru eviction for cache",
  '    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru --save "" --appendonly no',
  "",
  "  redis-queue:",
  "    image: redis:7-alpine",
  "    # AOF persistence, noeviction for BullMQ/Locks/RateLimits",
  "    ports:",
  '      - "6380:6379"',
  "    volumes:",
  "      - redis_queue_data:/data",
  "",
  "volumes:",
  "  postgres_data:",
  "  redis_queue_data:",
].join("\r\n");

describe("parseComposeServices", () => {
  test("reads this repository's compose file: three services with images", () => {
    assert.deepEqual(parseComposeServices(CODEPILOT_COMPOSE), [
      { name: "postgres", image: "pgvector/pgvector:pg17" },
      { name: "redis-cache", image: "redis:7-alpine" },
      { name: "redis-queue", image: "redis:7-alpine" },
    ]);
  });

  test("ignores column-0 comments, nested image keys and top-level keys after services", () => {
    const yaml = [
      "version: '3'",
      "services:",
      "# Database",
      "  db:",
      "    build:",
      "      image: should-not-be-read",
      "    image: postgres:16",
      '  "quoted-name":',
      "    image: 'redis:7'",
      "networks:",
      "  default:",
    ].join("\n");
    assert.deepEqual(parseComposeServices(yaml), [
      { name: "db", image: "postgres:16" },
      { name: "quoted-name", image: "redis:7" },
    ]);
  });

  test("returns [] rather than guessing for shapes it does not read", () => {
    assert.deepEqual(parseComposeServices("services: {db: {image: postgres}}"), []);
    assert.deepEqual(parseComposeServices("version: '2'\nweb:\n  image: nginx\n"), []);
    assert.deepEqual(parseComposeServices(""), []);
  });

  test("a service with no image is still listed", () => {
    assert.deepEqual(parseComposeServices("services:\n  api:\n    build: .\n"), [{ name: "api", image: null }]);
  });
});

describe("parsePackageManifest", () => {
  test("extracts names only, and drops the @types/ namespace from dev tooling", () => {
    const m = parsePackageManifest(
      JSON.stringify({
        name: "backend",
        scripts: { dev: "tsx watch src/server.ts", worker: "tsx watch src/worker.ts" },
        dependencies: { express: "^4", bullmq: "^6" },
        devDependencies: { typescript: "^5", "@types/node": "^22", tsx: "^4" },
      }),
    );
    assert.deepEqual(m, {
      name: "backend",
      dependencies: ["express", "bullmq"],
      devDependencies: ["typescript", "tsx"],
      scripts: ["dev", "worker"],
    });
  });

  test("returns null instead of throwing on invalid or non-object JSON", () => {
    assert.equal(parsePackageManifest("{ not json"), null);
    assert.equal(parsePackageManifest("[1,2]"), null);
    assert.equal(parsePackageManifest("null"), null);
  });

  test("tolerates missing or malformed sections", () => {
    assert.deepEqual(parsePackageManifest(JSON.stringify({ dependencies: ["not", "an", "object"] })), {
      name: null, dependencies: [], devDependencies: [], scripts: [],
    });
  });
});

describe("extractReadmePurpose", () => {
  test("skips headings, badges, images and HTML, and takes the first paragraph", () => {
    const readme = [
      "# 🔗 URL Shortener",
      "[![build](https://x/badge.svg)](https://x)",
      "![logo](logo.png)",
      "<p align=center>hi</p>",
      "",
      "A fast URL shortener built with Express",
      "and MongoDB.",
      "",
      "Second paragraph is ignored.",
    ].join("\n");
    assert.equal(extractReadmePurpose(readme), "A fast URL shortener built with Express and MongoDB.");
  });

  test("caps at a word boundary and returns null when there is no prose", () => {
    const long = `# T\n${"word ".repeat(100)}`;
    const purpose = extractReadmePurpose(long, 50)!;
    assert.ok(purpose.length <= 51 && purpose.endsWith("…"), purpose);
    assert.equal(extractReadmePurpose("# Only a heading\n\n## Another"), null);
  });
});

describe("selectBootstrapFiles", () => {
  test("uses the fixed basename list and never bare index.*", () => {
    assert.deepEqual(
      selectBootstrapFiles([
        "frontend/src/features/auth/index.ts",
        "frontend/src/routes/index.tsx",
        "backend/src/worker.ts",
        "frontend/src/main.tsx",
        "backend/src/server.ts",
        "frontend/src/App.tsx",
        "backend/src/app.ts",
        "backend/src/config/env.ts",
        "backend/scripts/manage.py",
        "src/serverless.ts",
      ]),
      ["backend/scripts/manage.py", "backend/src/app.ts", "backend/src/server.ts", "backend/src/worker.ts", "frontend/src/App.tsx", "frontend/src/main.tsx"],
    );
  });
});

const baseFacts = (): RepositoryProfileFacts => ({
  purpose: "Repo-aware AI platform.",
  featureModules: [],
  infrastructureModules: [],
  composeFiles: [],
  manifests: [],
  bootstrapFiles: [],
  mostReferencedFiles: [],
});

describe("renderRepositoryProfile", () => {
  test("lists feature modules by file count and puts infrastructure modules on their own later line", () => {
    const { text } = renderRepositoryProfile({
      ...baseFacts(),
      featureModules: [
        { module: "Interview", fileCount: 7 },
        { module: "Repository", fileCount: 15 },
        { module: "Review", fileCount: 8 },
      ],
      infrastructureModules: [
        { module: "Shared", fileCount: 18 },
        { module: "Configuration", fileCount: 7 },
      ],
    });
    const lines = text.split("\n");
    const featureLine = lines.findIndex((l) => l.startsWith("Feature modules"));
    const infraLine = lines.findIndex((l) => l.startsWith("Shared/infrastructure modules"));
    assert.ok(featureLine >= 0 && infraLine > featureLine, text);
    assert.equal(lines[featureLine], "Feature modules (by file count): Repository (15), Review (8), Interview (7)");
    assert.ok(!lines[featureLine].includes("Shared"), "the largest module is infrastructure, not a feature");
  });

  test("every capped list states shown-of-total; complete lists do not", () => {
    const { text } = renderRepositoryProfile({
      ...baseFacts(),
      featureModules: Array.from({ length: 31 }, (_, i) => ({ module: `M${String(i).padStart(2, "0")}`, fileCount: 40 - i })),
      manifests: [
        { filePath: "backend/package.json", manifest: { name: "b", dependencies: Array.from({ length: 15 }, (_, i) => `dep${i}`), devDependencies: [], scripts: ["dev", "worker"] } },
      ],
      bootstrapFiles: ["backend/src/server.ts", "backend/src/worker.ts"],
    });
    assert.match(text, /^Feature modules \(10 of 31, by file count\): /m);
    assert.match(text, /^Dependencies \(backend\/package\.json, 10 of 15\): /m);
    assert.match(text, /^Scripts \(backend\/package\.json\): dev, worker$/m);
    assert.match(text, /^Bootstrap files: backend\/src\/server\.ts, backend\/src\/worker\.ts$/m);
  });

  test("never exceeds the hard cap, and truncation removes the lowest-priority lines first", () => {
    const facts: RepositoryProfileFacts = {
      purpose: "p".repeat(REPOSITORY_PROFILE_LIMITS.purposeChars),
      featureModules: Array.from({ length: 50 }, (_, i) => ({ module: `FeatureModuleNumber${i}`, fileCount: 100 - i })),
      infrastructureModules: [{ module: "Shared", fileCount: 3 }],
      composeFiles: [{ filePath: "docker-compose.yml", services: Array.from({ length: 9 }, (_, i) => ({ name: `svc${i}`, image: `image-with-a-long-name-${i}:latest` })) }],
      manifests: Array.from({ length: 5 }, (_, m) => ({
        filePath: `pkg${m}/package.json`,
        manifest: { name: null, dependencies: Array.from({ length: 30 }, (_, i) => `some-dependency-${i}`), devDependencies: Array.from({ length: 9 }, (_, i) => `tool-${i}`), scripts: Array.from({ length: 9 }, (_, i) => `script-${i}`) },
      })),
      bootstrapFiles: Array.from({ length: 9 }, (_, i) => `apps/app${i}/src/server.ts`),
      mostReferencedFiles: Array.from({ length: 9 }, (_, i) => ({ path: `src/shared/very/deep/path/file${i}.ts`, count: 50 - i })),
    };
    const { text, truncated } = renderRepositoryProfile(facts);
    assert.ok(text.length <= REPOSITORY_PROFILE_LIMITS.maxChars, `${text.length} chars`);
    assert.equal(truncated, true);
    assert.ok(text.startsWith("Purpose: "));
    assert.ok(text.includes("Feature modules"), "high-priority line survives");
    assert.ok(!text.includes("Most referenced files"), "lowest-priority line is the first to go");
  });

  test("omits lines with no facts instead of rendering empty labels", () => {
    const { text } = renderRepositoryProfile({ ...baseFacts(), purpose: null });
    assert.equal(text, "");
  });
});

describe("renderModuleProfile", () => {
  test("ranks files by fan-in, caps every list with totals, and stays under the hard cap", () => {
    const { text, truncated } = renderModuleProfile({
      module: "Repository",
      files: Array.from({ length: 15 }, (_, i) => ({ path: `backend/src/features/repository/file${i}.ts`, fanIn: i })),
      exportedSymbols: Array.from({ length: 30 }, (_, i) => `RepositoryService.method${i}`),
      importsFrom: [{ module: "Shared", edges: 9 }, { module: "Retrieval", edges: 2 }],
      importedBy: Array.from({ length: 8 }, (_, i) => ({ module: `Consumer${i}`, edges: i })),
    });
    assert.ok(text.length <= MODULE_PROFILE_LIMITS.maxChars, `${text.length} chars`);
    assert.match(text, /^Module: Repository \(15 files\)$/m);
    assert.match(text, /^Files \(6 of 15, by import fan-in\): backend\/src\/features\/repository\/file14\.ts, /m);
    assert.match(text, /^Imports from: Shared, Retrieval$/m);
    assert.equal(typeof truncated, "boolean");
  });
});
