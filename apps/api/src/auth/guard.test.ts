import type { UserId } from "@portal/domain";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createSessionGuard } from "./guard.js";
import type { AuthPersistence, AuthUser } from "./types.js";

const userId = "41000000-0000-4000-8000-000000000001" as UserId;

describe("session moderation restriction composition", () => {
  it("blocks only the requested feature mutation and preserves safe reads", async () => {
    const guard = createSessionGuard(
      persistence(user({ activeModerationScopes: ["MESSAGING"] })),
    );

    await expect(
      guard.evaluate(request("POST"), "MESSAGING"),
    ).resolves.toMatchObject({ status: "ACCOUNT_NOT_ACTIVE" });
    await expect(
      guard.evaluate(request("POST"), "QUOTING"),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(
      guard.evaluate(request("GET"), "MESSAGING"),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("lets an ACCOUNT-restricted user read history and appeal but not mutate", async () => {
    const guard = createSessionGuard(
      persistence(user({ activeModerationScopes: ["ACCOUNT"] })),
    );

    await expect(guard.evaluate(request("GET"))).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(guard.evaluate(request("POST"))).resolves.toMatchObject({
      status: "ACCOUNT_NOT_ACTIVE",
    });
    await expect(
      guard.evaluate(request("POST"), "RESTRICTED_ACCOUNT_APPEAL"),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(
      guard.evaluate(request("POST"), "PRIVACY_REQUEST"),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("does not turn the appeal exception into ordinary suspended access", async () => {
    const guard = createSessionGuard(
      persistence(user({ accountState: "SUSPENDED" })),
    );

    await expect(guard.evaluate(request("GET"))).resolves.toMatchObject({
      status: "ACCOUNT_NOT_ACTIVE",
    });
    await expect(
      guard.evaluate(request("POST"), "RESTRICTED_ACCOUNT_APPEAL"),
    ).resolves.toMatchObject({
      status: "ACCOUNT_NOT_ACTIVE",
      user: { accountState: "SUSPENDED" },
    });
  });
});

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    activeModerationScopes: [],
    accountState: "ACTIVE",
    adultAttestedAt: new Date("2026-09-01T00:00:00.000Z"),
    emailVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    id: userId,
    phoneVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function persistence(authUser: AuthUser): AuthPersistence {
  return {
    findUserById: vi.fn(() => Promise.resolve(authUser)),
  } as unknown as AuthPersistence;
}

function request(method: "GET" | "POST"): FastifyRequest {
  return {
    method,
    session: {
      destroy: vi.fn(() => Promise.resolve()),
      get: vi.fn(() => userId),
    },
  } as unknown as FastifyRequest;
}
