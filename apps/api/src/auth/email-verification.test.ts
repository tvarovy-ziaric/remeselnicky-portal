import { createHash } from "node:crypto";

import type { UserId } from "@portal/domain";
import { describe, expect, it } from "vitest";

import {
  createEmailVerificationService,
  createEmailVerificationTokenService,
  type EmailVerificationPersistence,
} from "./email-verification.js";

const USER_ID = "0198ddec-56bd-7f4c-8752-1daa51fd9921" as UserId;

describe("email-verification primitives", () => {
  it("generates distinct 256-bit opaque tokens and stable SHA-256 digests", () => {
    const tokens = createEmailVerificationTokenService();
    const generated = Array.from({ length: 32 }, () => tokens.generate());

    expect(new Set(generated)).toHaveLength(generated.length);
    for (const token of generated) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(tokens.digest(token)).toBe(
        createHash("sha256").update(token, "utf8").digest("hex"),
      );
      expect(tokens.digest(token)).not.toContain(token);
    }
  });

  it("passes only a digest to persistence and plaintext only to delivery", async () => {
    const rawToken = "email-verification-token-aaaaaaaaaaaaaaaaaaaa";
    const observedDigests: string[] = [];
    const deliveries: { normalizedEmail: string; token: string }[] = [];
    const persistence: EmailVerificationPersistence = {
      consume: () => Promise.resolve("INVALID"),
      issue(input) {
        observedDigests.push(input.tokenDigest);
        return Promise.resolve({
          normalizedEmail: "person@example.test",
          status: "ISSUED",
        });
      },
    };
    const service = createEmailVerificationService({
      clock: () => new Date("2026-09-14T10:00:00.000Z"),
      delivery: {
        deliver(input) {
          deliveries.push(input);
          return Promise.resolve();
        },
      },
      persistence,
      tokens: {
        digest: (token) =>
          createHash("sha256").update(token, "utf8").digest("hex"),
        generate: () => rawToken,
      },
      tokenTtlMs: 60_000,
    });

    await service.request(USER_ID);

    expect(observedDigests).toEqual([
      createHash("sha256").update(rawToken, "utf8").digest("hex"),
    ]);
    expect(observedDigests.join()).not.toContain(rawToken);
    expect(deliveries).toEqual([
      { normalizedEmail: "person@example.test", token: rawToken },
    ]);
  });

  it("keeps already-verified resend behavior indistinguishable", async () => {
    let delivered = false;
    const service = createEmailVerificationService({
      delivery: {
        deliver: () => {
          delivered = true;
          return Promise.resolve();
        },
      },
      persistence: {
        consume: () => Promise.resolve("INVALID"),
        issue: () => Promise.resolve({ status: "NOT_ELIGIBLE" }),
      },
      tokenTtlMs: 60_000,
    });

    await expect(service.request(USER_ID)).resolves.toBeUndefined();
    expect(delivered).toBe(false);
  });
});
