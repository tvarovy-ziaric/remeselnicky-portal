import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatDiagnostic,
  verifyWorkspace,
} from "./verify-import-boundaries.mjs";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "portal-boundaries-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const baseline = {
    "apps/api/package.json": JSON.stringify({ name: "@portal/api" }),
    "apps/web/package.json": JSON.stringify({ name: "@portal/web" }),
    "packages/config/package.json": JSON.stringify({ name: "@portal/config" }),
    "packages/domain/package.json": JSON.stringify({ name: "@portal/domain" }),
    "packages/shared/package.json": JSON.stringify({ name: "@portal/shared" }),
    ...files,
  };

  for (const [relativePath, contents] of Object.entries(baseline)) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }
  return root;
}

test("accepts framework-free shared packages and client-safe web imports", async (t) => {
  const root = await fixture(t, {
    "apps/web/src/page.ts":
      'import { value } from "@portal/config";\nexport { value };\n',
    "packages/shared/src/index.ts":
      'export type { EntityId } from "@portal/domain";\n',
  });

  assert.deepEqual(await verifyWorkspace(root), []);
});

test("rejects shared-package manifest and source references to apps", async (t) => {
  const root = await fixture(t, {
    "packages/shared/package.json": JSON.stringify({
      name: "@portal/shared",
      dependencies: { "@portal/api": "workspace:*" },
    }),
    "packages/shared/src/direct.ts": 'import "@portal/api/testing";\n',
    "packages/shared/src/relative.ts":
      'export * from "../../../apps/web/src/page";\n',
  });

  const output = (await verifyWorkspace(root)).map(formatDiagnostic);
  assert.equal(output.length, 3);
  assert.ok(output.every((line) => line.includes("[shared-no-app]")));
  assert.ok(
    output.some((line) =>
      line.includes("dependencies must not reference app package @portal/api"),
    ),
  );
  assert.ok(output.some((line) => line.includes("direct.ts:1")));
  assert.ok(output.some((line) => line.includes("relative.ts:1")));
});

test("rejects database and server-only config imports from web", async (t) => {
  const root = await fixture(t, {
    "apps/web/package.json": JSON.stringify({
      name: "@portal/web",
      dependencies: {
        "@portal/db": "workspace:*",
        "@portal/config": "workspace:*",
      },
    }),
    "apps/web/src/db.ts":
      'const db = await import("@portal/db/client");\nexport default db;\n',
    "apps/web/src/env.ts": 'export { env } from "@portal/config/server";\n',
  });

  const output = (await verifyWorkspace(root)).map(formatDiagnostic);
  assert.equal(output.length, 3);
  assert.ok(output.every((line) => line.includes("[web-server-boundary]")));
  assert.ok(output.some((line) => line.includes("@portal/db/client")));
  assert.ok(output.some((line) => line.includes("@portal/config/server")));
});

test("keeps domain free of framework and app dependencies/imports", async (t) => {
  const root = await fixture(t, {
    "packages/domain/package.json": JSON.stringify({
      name: "@portal/domain",
      dependencies: { fastify: "1.0.0" },
      devDependencies: { "@portal/api": "workspace:*", vitest: "1.0.0" },
    }),
    "packages/domain/src/adapter.ts": [
      'import type { FastifyInstance } from "fastify";',
      'const api = require("@portal/api");',
      "export { api };",
      "",
    ].join("\n"),
  });

  const output = (await verifyWorkspace(root)).map(formatDiagnostic);
  const domainOutput = output.filter((line) =>
    line.includes("[domain-framework-free]"),
  );
  assert.equal(domainOutput.length, 4);
  assert.ok(
    domainOutput.some((line) =>
      line.includes("dependencies must not reference fastify"),
    ),
  );
  assert.ok(
    domainOutput.some((line) =>
      line.includes("devDependencies must not reference @portal/api"),
    ),
  );
  assert.ok(domainOutput.some((line) => line.includes("adapter.ts:1")));
  assert.ok(domainOutput.some((line) => line.includes("adapter.ts:2")));
  assert.ok(!domainOutput.some((line) => line.includes("vitest")));
});

test("returns violations in deterministic path and line order", async (t) => {
  const root = await fixture(t, {
    "apps/web/src/z.ts": 'import "@portal/db";\n',
    "apps/web/src/a.ts": '\nimport "@portal/config/server/runtime";\n',
  });

  const output = (await verifyWorkspace(root)).map(formatDiagnostic);
  assert.match(output[0], /^apps\/web\/src\/a\.ts:2 /);
  assert.match(output[1], /^apps\/web\/src\/z\.ts:1 /);
});
