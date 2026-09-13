import { createHash } from "node:crypto";

import type {
  FastifyRateLimitOptions,
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
} from "@fastify/rate-limit";

import type { AuthPersistence } from "./types.js";

export function createPostgresRateLimitStoreConstructor(input: {
  readonly clock?: () => Date;
  readonly persistence: AuthPersistence;
}): FastifyRateLimitStoreCtor {
  const clock = input.clock ?? (() => new Date());

  return class PostgresRateLimitStore implements FastifyRateLimitStore {
    private scope = "auth";

    public constructor(options: FastifyRateLimitOptions) {
      void options;
    }

    public child(options: FastifyRateLimitOptions): FastifyRateLimitStore {
      const store = new PostgresRateLimitStore({});
      const route = (
        options as FastifyRateLimitOptions & {
          readonly routeInfo?: {
            readonly method?: string | readonly string[];
            readonly url?: string;
          };
        }
      ).routeInfo;
      const method = Array.isArray(route?.method)
        ? route.method.join("+")
        : route?.method;
      store.scope = `${String(method).toLowerCase()}:${route?.url ?? "auth"}`;
      return store;
    }

    public incr(
      key: string,
      callback: (
        error: Error | null,
        result?: { current: number; ttl: number },
      ) => void,
      timeWindow: number,
      max: number,
    ): void {
      const keyDigest = createHash("sha256")
        .update(`${this.scope}\u0000${key}`, "utf8")
        .digest("hex");
      input.persistence
        .consumeRateLimit({
          keyDigest,
          limit: max,
          now: clock(),
          scope: this.scope,
          timeWindowMs: timeWindow,
        })
        .then(
          (result) =>
            callback(null, {
              current: result.current,
              ttl: result.ttlMs,
            }),
          () => callback(new Error("Rate-limit persistence unavailable")),
        );
    }
  };
}
