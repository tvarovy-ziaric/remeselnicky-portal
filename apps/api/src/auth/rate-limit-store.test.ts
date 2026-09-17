import { describe, expect, it, vi } from "vitest";

import type { AuthPersistence } from "./types.js";
import { createPostgresRateLimitStoreConstructor } from "./rate-limit-store.js";

describe("PostgreSQL rate-limit route scopes", () => {
  it("keeps long routes inside the database bound without merging distinct routes", async () => {
    const consumeRateLimit = vi.fn().mockResolvedValue({
      current: 1,
      ttlMs: 1_000,
    });
    const Store = createPostgresRateLimitStoreConstructor({
      persistence: { consumeRateLimit } as unknown as AuthPersistence,
    });
    const parent = new Store({});
    const route =
      "/v1/me/jobs/:jobId/change-order-revisions/:revisionId/pdf/:mediaAssetId/status";
    const first = parent.child({
      routeInfo: { method: "GET", url: route },
    } as unknown as Parameters<typeof parent.child>[0]);
    const second = parent.child({
      routeInfo: { method: "GET", url: `${route}-other` },
    } as unknown as Parameters<typeof parent.child>[0]);

    await increment(first);
    await increment(second);

    const firstInput: unknown = consumeRateLimit.mock.calls[0]?.[0];
    const secondInput: unknown = consumeRateLimit.mock.calls[1]?.[0];
    const firstScope = (firstInput as { scope: string }).scope;
    const secondScope = (secondInput as { scope: string }).scope;
    expect(firstScope.length).toBeLessThanOrEqual(80);
    expect(secondScope.length).toBeLessThanOrEqual(80);
    expect(firstScope).not.toBe(secondScope);
  });
});

function increment(store: {
  incr(
    key: string,
    callback: (
      error: Error | null,
      result?: { current: number; ttl: number },
    ) => void,
    timeWindow: number,
    max: number,
  ): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    store.incr(
      "synthetic-client",
      (error) => (error === null ? resolve() : reject(error)),
      1_000,
      10,
    );
  });
}
