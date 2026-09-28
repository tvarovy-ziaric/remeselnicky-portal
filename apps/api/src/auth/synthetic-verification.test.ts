import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSyntheticVerificationRuntime } from "./synthetic-verification.js";

const signingKey = "a".repeat(64);
const ingestKey = "b".repeat(64);
const nonce = "1".repeat(32);
const mac = createHmac("sha256", signingKey)
  .update(`portal-synthetic-registration-v1\0${nonce}`, "utf8")
  .digest("hex")
  .slice(0, 32);
const email = `synthetic.e2e.${nonce}.${mac}@portal.invalid`;

afterEach(() => vi.unstubAllGlobals());

describe("synthetic verification runtime", () => {
  it("accepts only a correctly signed synthetic registration identity", async () => {
    const runtime = runtimeFixture();
    await expect(
      runtime.eligibility.isEligible({ normalizedEmail: email }),
    ).resolves.toBe(true);
    await expect(
      runtime.eligibility.isEligible({
        normalizedEmail: `synthetic.e2e.${nonce}.${"0".repeat(32)}@portal.invalid`,
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.eligibility.isEligible({ normalizedEmail: "person@example.sk" }),
    ).resolves.toBe(false);
  });

  it("binds signed synthetic eligibility to registration admission", async () => {
    const runtime = runtimeFixture();
    const register = vi
      .fn()
      .mockResolvedValue({ status: "DUPLICATE" as const });
    const admission = runtime.createAdmission({ register });
    const registration = {
      adultAttested: true as const,
      normalizedEmail: email,
      passwordHash: "opaque-password-hash",
    };

    await expect(admission.register(registration)).resolves.toEqual({
      status: "DUPLICATE",
    });
    expect(register).toHaveBeenCalledWith(registration);
    await expect(
      admission.register({
        ...registration,
        normalizedEmail: "person@example.sk",
      }),
    ).resolves.toEqual({ status: "NOT_AVAILABLE" });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("delivers only synthetic destinations to the fixed internal sink", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: true }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = runtimeFixture();

    await runtime.emailDelivery.deliver({
      normalizedEmail: email,
      token: "x".repeat(43),
    });
    await runtime.phoneDelivery.deliver({
      normalizedPhone: "+9991234567890",
      otp: "123456",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://synthetic-verification-sink:8467/v1/deliver",
    );
    await expect(
      runtime.phoneDelivery.deliver({
        normalizedPhone: "+421900000000",
        otp: "123456",
      }),
    ).rejects.toThrow(/destination rejected/u);
  });

  it("fails closed outside staging and sanitizes sink failures", async () => {
    expect(() =>
      createSyntheticVerificationRuntime({
        environment: "production",
        ingestKey,
        registrationSigningKey: signingKey,
        sinkOrigin: "http://synthetic-verification-sink:8467",
      }),
    ).toThrow(/restricted/u);

    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("plaintext-token-must-not-surface", { status: 500 }),
        ),
    );
    await expect(
      runtimeFixture().emailDelivery.deliver({
        normalizedEmail: email,
        token: "secret-token-value-that-must-not-surface",
      }),
    ).rejects.toThrow("Synthetic verification delivery unavailable.");
  });
});

function runtimeFixture() {
  return createSyntheticVerificationRuntime({
    environment: "staging",
    ingestKey,
    registrationSigningKey: signingKey,
    sinkOrigin: "http://synthetic-verification-sink:8467",
  });
}
