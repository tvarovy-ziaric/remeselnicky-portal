import type { Sql } from "postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  authCredentials,
  authRateLimitBuckets,
  authSessions,
  createAuthRepository,
  passwordResetTokens,
  type NewAuthCredentialRecord,
  type NewAuthSessionRecord,
} from "../src/index.js";

describe("authentication persistence schema", () => {
  it("fails closed when explicit adult attestation is absent at runtime", async () => {
    const repository = createAuthRepository({} as Sql);

    await expect(
      repository.registerUserWithCredential({
        adultAttested: false,
        normalizedEmail: "user@example.test",
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$hash-placeholder",
      } as unknown as Parameters<
        typeof repository.registerUserWithCredential
      >[0]),
    ).rejects.toThrow("Explicit adult attestation is required");
  });

  it("stores credential identity and 18+ attestation without plaintext secrets", () => {
    const config = getTableConfig(authCredentials);

    expect(config.columns.map(({ name }) => name)).toEqual([
      "user_id",
      "normalized_email",
      "password_hash",
      "adult_attested_at",
      "password_changed_at",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.columns.some(({ name }) =>
        ["password", "plaintext_password", "reset_token"].includes(name),
      ),
    ).toBe(false);

    const insert: NewAuthCredentialRecord = {
      userId: "00000000-0000-4000-8000-000000000001",
      normalizedEmail: "user@example.test",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$hash-placeholder",
    };
    expect(insert.adultAttestedAt).toBeUndefined();
  });

  it("uses digest-keyed server sessions with nullable pre-auth users", () => {
    const config = getTableConfig(authSessions);
    expect(config.columns.map(({ name }) => name)).toEqual([
      "session_id_hash",
      "user_id",
      "payload",
      "created_at",
      "last_seen_at",
      "expires_at",
      "revoked_at",
    ]);

    const preAuthSession: NewAuthSessionRecord = {
      sessionIdHash: "a".repeat(64),
      userId: null,
      payload: {},
      expiresAt: new Date("2026-09-15T00:00:00.000Z"),
    };
    expect(preAuthSession.userId).toBeNull();
  });

  it("stores reset and rate-limit keys only as digests", () => {
    const resetConfig = getTableConfig(passwordResetTokens);
    expect(resetConfig.columns.map(({ name }) => name)).toEqual([
      "id",
      "user_id",
      "token_digest",
      "created_at",
      "expires_at",
      "consumed_at",
      "invalidated_at",
    ]);
    expect(
      resetConfig.indexes.find(
        ({ config }) => config.name === "password_reset_tokens_live_user_idx",
      )?.config.unique,
    ).toBe(true);
    expect(
      getTableConfig(authRateLimitBuckets).columns.map(({ name }) => name),
    ).toEqual([
      "scope",
      "key_digest",
      "window_started_at",
      "expires_at",
      "attempt_count",
    ]);
  });
});
