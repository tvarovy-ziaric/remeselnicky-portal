import { describe, expect, it, vi } from "vitest";

import {
  assertAuthorizationDenied,
  assertUniformNotFound,
  createAuthenticatedTestClient,
  createAuthenticatedTestClients,
  createPrivateFileIdorFixture,
  createSyntheticAccountFixture,
  createSyntheticSeedCatalog,
  runConcurrentAttempts,
  verifyExactlyOnceCommand,
  verifyPrivateFileIdorDenials,
  type TestHttpRequest,
  type TestHttpResponse,
} from "../src/index.js";

const hiddenSessionValue = "synthetic-session-credential-0001";

describe("authenticated request clients", () => {
  it("authenticates multiple synthetic roles without serializing credentials", async () => {
    const seen: TestHttpRequest[] = [];
    const clients = createAuthenticatedTestClients({
      fixtures: createSyntheticSeedCatalog().accounts,
      sessionCookieName: "portal_session",
      sessionCookieValueFor: ({ fixtureId }) =>
        `synthetic-session-${fixtureId}`,
      transport: {
        execute(request) {
          seen.push(request);
          return Promise.resolve(response(204));
        },
      },
    });

    await clients.CUSTOMER?.request({ method: "GET", path: "/v1/me" });
    await clients.SUPERADMIN?.request({ method: "POST", path: "/v1/admin" });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers?.cookie).toContain("synthetic-account-101");
    expect(JSON.stringify(clients)).not.toContain("synthetic-session-");
    expect(clients.SUPERADMIN?.toJSON()).toMatchObject({
      accountKind: "SUPERADMIN",
      authenticated: true,
      synthetic: true,
    });
  });

  it("blocks caller auth overrides and redacts transport failures", async () => {
    const client = createAuthenticatedTestClient({
      fixture: createSyntheticAccountFixture("CUSTOMER"),
      sessionCookieName: "portal_session",
      sessionCookieValue: hiddenSessionValue,
      transport: {
        execute: () =>
          Promise.reject(new Error(`request contained ${hiddenSessionValue}`)),
      },
    });
    await expect(
      client.request({
        headers: { Authorization: "caller-controlled" },
        method: "GET",
        path: "/v1/me",
      }),
    ).rejects.not.toThrow(hiddenSessionValue);
    await expect(
      client.request({ method: "GET", path: "/v1/me" }),
    ).rejects.toThrow("Authenticated test request transport failed");
    await expect(
      client.request({ method: "GET", path: "/v1/me" }),
    ).rejects.not.toThrow(hiddenSessionValue);
  });

  it("accepts only application-relative request paths", async () => {
    const client = createAuthenticatedTestClient({
      fixture: createSyntheticAccountFixture("CUSTOMER"),
      sessionCookieName: "portal_session",
      sessionCookieValue: hiddenSessionValue,
      transport: { execute: () => Promise.resolve(response(200)) },
    });
    await expect(
      client.request({ method: "GET", path: "https://external.invalid/me" }),
    ).rejects.toThrow(/application-relative/u);
  });
});

describe("negative authorization helpers", () => {
  it("accepts deny statuses and rejects leaked markers", () => {
    expect(() =>
      assertAuthorizationDenied(response(403, { code: "FORBIDDEN" })),
    ).not.toThrow();
    expect(() =>
      assertAuthorizationDenied(response(200, { code: "OK" })),
    ).toThrow(/denial/u);
    expect(() =>
      assertAuthorizationDenied(response(200), { allowedStatusCodes: [200] }),
    ).toThrow(/subset/u);
    expect(() =>
      assertAuthorizationDenied(response(404, { ownerId: "private-owner" }), {
        forbiddenResponseMarkers: ["private-owner"],
      }),
    ).toThrow(/leaked/u);
  });

  it("requires uniform non-cacheable 404 responses without redirects", () => {
    const denied = response(
      404,
      { code: "NOT_FOUND" },
      {
        "cache-control": "private, no-store",
      },
    );
    expect(() => assertUniformNotFound([denied, denied])).not.toThrow();
    expect(() =>
      assertUniformNotFound([
        denied,
        response(
          404,
          { code: "PRIVATE_OBJECT" },
          {
            "cache-control": "private, no-store",
          },
        ),
      ]),
    ).toThrow(/uniform/u);
  });
});

describe("private file IDOR fixture", () => {
  it("covers unrelated roles, privileged roles, suspension and anonymous access", async () => {
    const fixture = createPrivateFileIdorFixture();
    const transport = {
      execute: vi.fn(() =>
        Promise.resolve(
          response(
            404,
            { code: "MEDIA_NOT_FOUND" },
            {
              "cache-control": "private, no-store",
            },
          ),
        ),
      ),
    };
    const clients = createAuthenticatedTestClients({
      fixtures: createSyntheticSeedCatalog().accounts,
      sessionCookieName: "portal_session",
      sessionCookieValueFor: ({ fixtureId }) =>
        `synthetic-session-${fixtureId}`,
      transport,
    });
    const responses = await verifyPrivateFileIdorDenials({
      anonymousTransport: transport,
      clients,
      fixture,
    });
    expect(responses).toHaveLength(fixture.deniedAccountKinds.length + 1);
    expect(transport.execute).toHaveBeenCalledTimes(responses.length);
    expect(fixture.deniedAccountKinds.includes("SUSPENDED")).toBe(true);
  });

  it("rejects a denial that discloses a private storage location", async () => {
    const fixture = createPrivateFileIdorFixture();
    const leakingTransport = {
      execute: () =>
        Promise.resolve(
          response(
            404,
            { location: fixture.privateStorageKey },
            {
              "cache-control": "private, no-store",
            },
          ),
        ),
    };
    const clients = createAuthenticatedTestClients({
      fixtures: createSyntheticSeedCatalog().accounts,
      sessionCookieName: "portal_session",
      sessionCookieValueFor: ({ fixtureId }) =>
        `synthetic-session-${fixtureId}`,
      transport: leakingTransport,
    });
    await expect(
      verifyPrivateFileIdorDenials({
        anonymousTransport: leakingTransport,
        clients,
        fixture,
      }),
    ).rejects.toThrow(/leaked/u);
  });
});

describe("concurrency and idempotency helpers", () => {
  it("releases every attempt from one barrier", async () => {
    const started: number[] = [];
    const results = await runConcurrentAttempts({
      attemptCount: 4,
      idempotencyKey: "test:quote-acceptance:0001",
      run: ({ attemptIndex }) => {
        started.push(attemptIndex);
        return Promise.resolve(attemptIndex);
      },
    });
    expect(started).toHaveLength(4);
    expect(results).toHaveLength(4);
  });

  it("proves exactly one effect and an effect-free retry", async () => {
    let committedEffects = 0;
    const operation = vi.fn(() => {
      if (committedEffects === 0) {
        committedEffects += 1;
        return Promise.resolve("COMMITTED" as const);
      }
      return Promise.resolve("IDEMPOTENT_REPLAY" as const);
    });
    const evidence = await verifyExactlyOnceCommand({
      attemptCount: 5,
      classify: (result) => result,
      countCommittedEffects: () => Promise.resolve(committedEffects),
      idempotencyKey: "test:quote-acceptance:0002",
      run: operation,
    });
    expect(evidence.effectsAfterConcurrency).toBe(1);
    expect(evidence.effectsAfterRetry).toBe(1);
    expect(operation).toHaveBeenCalledTimes(6);
  });

  it("fails evidence when the command duplicates a business effect", async () => {
    let committedEffects = 0;
    await expect(
      verifyExactlyOnceCommand({
        idempotencyKey: "test:unsafe-command:0001",
        classify: () => "COMMITTED",
        countCommittedEffects: () => Promise.resolve(committedEffects),
        run: () => {
          committedEffects += 1;
          return Promise.resolve("done");
        },
      }),
    ).rejects.toThrow(/one committed effect/u);
  });

  it("rejects unsafe keys and unbounded fan-out", async () => {
    await expect(
      runConcurrentAttempts({
        attemptCount: 1,
        idempotencyKey: "person@example.invalid",
        run: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/between 2 and 32/u);
    await expect(
      runConcurrentAttempts({
        idempotencyKey: "person@example.invalid",
        run: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/machine-safe/u);
  });
});

function response(
  statusCode: number,
  body?: unknown,
  headers: Readonly<Record<string, string | undefined>> = {},
): TestHttpResponse {
  return { body, headers, statusCode };
}
