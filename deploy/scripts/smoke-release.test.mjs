import assert from "node:assert/strict";
import test from "node:test";

import { runReleaseSmoke } from "./smoke-release.mjs";

const revision = "a".repeat(40);

test("proves public web, auth, database readiness and revision monitoring", async () => {
  const visited = [];
  const result = await runReleaseSmoke({
    apiUrl: "http://127.0.0.1:18081",
    expectedRevision: revision,
    fetcher: (url) => {
      visited.push(url.pathname);
      return Promise.resolve(responseFor(url.pathname));
    },
    metricsUrl: "http://127.0.0.1:19464",
    webUrl: "http://127.0.0.1:18080",
  });
  assert.deepEqual(visited, [
    "/",
    "/health/live",
    "/health/ready",
    "/v1/auth/csrf",
    "/metrics",
  ]);
  assert.equal(Object.values(result).every(Boolean), true);
});

test("fails when readiness does not prove the database", async () => {
  await assert.rejects(
    runReleaseSmoke({
      apiUrl: "http://localhost:18081",
      expectedRevision: revision,
      fetcher: (url) =>
        Promise.resolve(
          url.pathname === "/health/ready"
            ? json({ checks: { database: "unavailable" }, status: "not_ready" })
            : responseFor(url.pathname),
        ),
      metricsUrl: "http://localhost:19464",
      webUrl: "http://localhost:18080",
    }),
    /database availability/u,
  );
});

test("fails on revision drift or cacheable auth", async () => {
  await assert.rejects(
    runReleaseSmoke({
      apiUrl: "http://localhost:18081",
      expectedRevision: revision,
      fetcher: (url) =>
        Promise.resolve(
          url.pathname === "/metrics"
            ? new Response('portal_info{release_revision="different"} 1\n')
            : responseFor(url.pathname),
        ),
      metricsUrl: "http://localhost:19464",
      webUrl: "http://localhost:18080",
    }),
    /expected release revision/u,
  );
  await assert.rejects(
    runReleaseSmoke({
      apiUrl: "http://localhost:18081",
      expectedRevision: revision,
      fetcher: (url) =>
        Promise.resolve(
          url.pathname === "/v1/auth/csrf"
            ? json({ csrfToken: "synthetic-csrf-challenge" })
            : responseFor(url.pathname),
        ),
      metricsUrl: "http://localhost:19464",
      webUrl: "http://localhost:18080",
    }),
    /cacheable/u,
  );
});

test("rejects remote plaintext and credential-bearing URLs before requests", async () => {
  for (const webUrl of [
    "http://staging.example.test",
    "https://user:credential@staging.example.test",
  ]) {
    await assert.rejects(
      runReleaseSmoke({
        apiUrl: "https://api.staging.example.test",
        expectedRevision: revision,
        fetcher: () => {
          throw new Error("must not fetch");
        },
        metricsUrl: "https://metrics.staging.example.test",
        webUrl,
      }),
      /TLS\/credential boundary/u,
    );
  }
});

function responseFor(path) {
  switch (path) {
    case "/":
      return new Response("public app");
    case "/health/live":
      return json({ status: "ok" });
    case "/health/ready":
      return json({ checks: { database: "available" }, status: "ready" });
    case "/v1/auth/csrf":
      return json(
        { csrfToken: "synthetic-csrf-challenge" },
        { "cache-control": "no-store" },
      );
    case "/metrics":
      return new Response(
        `portal_http_requests_total{release_revision="${revision}",service="api"} 1\n`,
      );
    default:
      return new Response("not found", { status: 404 });
  }
}

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
}
