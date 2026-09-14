import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMonitoringServer,
  createPortalMetrics,
  type MonitoringServer,
} from "../src/index.js";

const servers: MonitoringServer[] = [];
const context = {
  environment: "staging",
  releaseRevision: "git-a1b2c3d4",
  service: "api",
} as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("bounded operational metrics", () => {
  it("records HTTP, database and queue baselines with deployment context", () => {
    const metrics = createPortalMetrics(context);

    metrics.recordHttp({
      durationMs: 42,
      method: "GET",
      route: "/v1/jobs/:jobId",
      statusCode: 200,
    });
    metrics.recordHttp({
      durationMs: 9,
      method: "POST",
      route: "/v1/auth/session",
      statusCode: 429,
    });
    metrics.recordDatabaseProbe({ durationMs: 7, result: "available" });
    metrics.recordQueueEvent("job_attempt_succeeded");
    metrics.setQueueSnapshot({
      depth: 2,
      inFlight: 1,
      oldestInFlightAgeMs: 500,
      oldestPendingAgeMs: 2_000,
    });

    const output = metrics.render();
    expect(output).toContain("portal_http_requests_total");
    expect(output).toContain('route="/v1/jobs/:jobId"');
    expect(output).toContain('result="rate_limited"');
    expect(output).toContain('environment="staging"');
    expect(output).toContain('release_revision="git-a1b2c3d4"');
    expect(output).toContain("portal_database_available");
    expect(output).toContain("portal_queue_depth");
    expect(output).toContain("portal_queue_jobs_total");
  });

  it("normalizes identifier-shaped routes and accepts no user/job labels", () => {
    const metrics = createPortalMetrics(context);
    const opaqueJobId = "018e1ca2-7f23-7b4a-bc04-123456789abc";

    metrics.recordHttp({
      durationMs: 10,
      method: "GET",
      route: `/v1/jobs/${opaqueJobId}`,
      statusCode: 403,
    });

    const output = metrics.render();
    expect(output).toContain('route="/v1/jobs/:id"');
    expect(output).toContain('result="authorization_denied"');
    expect(output).not.toContain(opaqueJobId);
    expect(output).not.toMatch(/user_?id=/iu);
    expect(output).not.toMatch(/job_?id=/iu);
  });

  it("caps route cardinality instead of creating unbounded series", () => {
    const metrics = createPortalMetrics(context);
    for (let index = 0; index < 140; index += 1) {
      metrics.recordHttp({
        durationMs: 1,
        method: "GET",
        route: `/synthetic/route-${index}`,
        statusCode: 200,
      });
    }

    const output = metrics.render();
    expect(output).toContain('route="other"');
    expect(output).not.toContain('route="/synthetic/route-139"');
  });

  it("serves only minimal health and metrics responses", async () => {
    const metrics = createPortalMetrics(context);
    metrics.setWorkerReady(false);
    const server = createMonitoringServer({ metrics, ready: () => false });
    servers.push(server);
    const port = await server.listen({ host: "127.0.0.1", port: 0 });

    const live = await get(port, "/health/live?ignored=1");
    const ready = await get(port, "/health/ready");
    const scrape = await get(port, "/metrics");
    const missing = await get(port, "/private/details");

    expect(live).toEqual({ body: '{"status":"ok"}', statusCode: 200 });
    expect(ready).toEqual({
      body: '{"status":"not_ready"}',
      statusCode: 503,
    });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.body).toContain("portal_worker_ready");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("private/details");
  });
});

function get(
  port: number,
  path: string,
): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const requestInstance = request(
      { host: "127.0.0.1", method: "GET", path, port },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ body, statusCode: response.statusCode ?? 0 }),
        );
      },
    );
    requestInstance.on("error", reject);
    requestInstance.end();
  });
}
