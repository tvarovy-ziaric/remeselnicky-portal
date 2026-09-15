import { createHash } from "node:crypto";

import { AUTH_API_PATHS } from "@portal/contracts";
import type { AuthRepository } from "@portal/db";
import {
  JobRequestDraftIdempotencyError,
  type CustomerProfileId,
  type JobRequestId,
  type PersistCreateDraftWithInitialSectionInput,
  type UserAccountState,
  type UserId,
} from "@portal/domain";
import type { Session } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "../app.js";
import { createAuthPersistence } from "./db-adapter.js";
import type {
  EmailVerificationPersistence,
  EmailVerificationTokenService,
} from "./email-verification.js";
import type {
  PhoneOtpCrypto,
  PhoneVerificationPersistence,
} from "./phone-verification.js";
import { createArgon2PasswordHasher } from "./password.js";
import { createPostgresRateLimitStoreConstructor } from "./rate-limit-store.js";
import { createPostgresSessionStore } from "./session-store.js";
import type {
  AuthCredential,
  AuthPersistence,
  AuthRuntimeConfig,
  AuthUser,
  PasswordHasher,
  RegistrationEligibilityPort,
  ResetTokenService,
  StoredSession,
} from "./types.js";

const USER_ID = "0198ddec-56bd-7f4c-8752-1daa51fd9921" as UserId;
const PASSWORD = "Correct horse battery staple";
const NEW_PASSWORD = "New correct horse battery staple";
const RESET_TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const VERIFICATION_TOKENS = [
  "email-verification-token-aaaaaaaaaaaaaaaaaaaa",
  "email-verification-token-bbbbbbbbbbbbbbbbbbbb",
  "email-verification-token-cccccccccccccccccccc",
] as const;
const NOW = new Date("2026-09-14T10:00:00.000Z");

const openApps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("authentication HTTP boundary", () => {
  it("preserves a private handoff across registration and consumes it exactly once", async () => {
    const fixture = createFixture({ draftHandoff: true, eligible: true });
    const anonymous = await csrf(fixture.app);
    const missingCsrf = await fixture.app.inject({
      headers: { cookie: anonymous.cookie },
      method: "POST",
      url: AUTH_API_PATHS.draftHandoffArm,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const armed = await fixture.app.inject({
      headers: {
        cookie: anonymous.cookie,
        "x-csrf-token": anonymous.token,
      },
      method: "POST",
      url: AUTH_API_PATHS.draftHandoffArm,
    });
    expect(armed.statusCode).toBe(204);
    const armedCookie = responseCookie(armed.headers["set-cookie"]);

    const registered = await fixture.app.inject({
      headers: { cookie: armedCookie, "x-csrf-token": anonymous.token },
      method: "POST",
      payload: {
        adultAttested: true,
        email: "person@example.com",
        password: PASSWORD,
      },
      url: AUTH_API_PATHS.register,
    });
    expect(registered.statusCode).toBe(201);
    const authCookie = responseCookie(registered.headers["set-cookie"]);
    const authCsrf = registered.json<{ csrfToken: string }>().csrfToken;
    const payload = {
      section: {
        key: "request.basics",
        payload: { description: "Oprava strechy" },
        schemaVersion: 1,
      },
    };
    const consumed = await fixture.app.inject({
      headers: { cookie: authCookie, "x-csrf-token": authCsrf },
      method: "POST",
      payload,
      url: AUTH_API_PATHS.draftHandoffConsume,
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json()).toEqual({
      jobRequestId: "97000000-0000-4000-8000-000000000099",
      revision: 1,
    });
    expect(consumed.body).not.toContain(
      fixture.draftCreations[0]?.commandId ?? "not-present",
    );
    expect(fixture.draftCreations).toHaveLength(1);

    const consumedCookie = responseCookie(consumed.headers["set-cookie"]);
    const retried = await fixture.app.inject({
      headers: { cookie: consumedCookie, "x-csrf-token": authCsrf },
      method: "POST",
      payload,
      url: AUTH_API_PATHS.draftHandoffConsume,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(consumed.json());
    expect(fixture.draftCreations).toHaveLength(2);
    expect(fixture.draftCreations[1]?.commandId).toBe(
      fixture.draftCreations[0]?.commandId,
    );

    const conflict = await fixture.app.inject({
      headers: { cookie: consumedCookie, "x-csrf-token": authCsrf },
      method: "POST",
      payload: {
        section: {
          ...payload.section,
          payload: { description: "Iný zámer" },
        },
      },
      url: AUTH_API_PATHS.draftHandoffConsume,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: "HANDOFF_CONFLICT" });
  });

  it("denies consuming a handoff without an authenticated session", async () => {
    const fixture = createFixture({ draftHandoff: true });
    const anonymous = await csrf(fixture.app);
    await fixture.app.inject({
      headers: {
        cookie: anonymous.cookie,
        "x-csrf-token": anonymous.token,
      },
      method: "POST",
      url: AUTH_API_PATHS.draftHandoffArm,
    });
    const response = await fixture.app.inject({
      headers: {
        cookie: anonymous.cookie,
        "x-csrf-token": anonymous.token,
      },
      method: "POST",
      payload: {
        section: { key: "request.basics", payload: {}, schemaVersion: 1 },
      },
      url: AUTH_API_PATHS.draftHandoffConsume,
    });
    expect(response.statusCode).toBe(401);
    expect(fixture.draftCreations).toHaveLength(0);
  });

  it("registers an eligible adult, regenerates the session, and logs out", async () => {
    const fixture = createFixture({ eligible: true });
    const { cookie: preLoginCookie, token } = await csrf(fixture.app);

    const registered = await fixture.app.inject({
      headers: { cookie: preLoginCookie, "x-csrf-token": token },
      method: "POST",
      payload: {
        adultAttested: true,
        email: "  Person@Example.COM ",
        password: PASSWORD,
      },
      url: AUTH_API_PATHS.register,
    });

    expect(registered.statusCode).toBe(201);
    const authenticatedCookie = responseCookie(
      registered.headers["set-cookie"],
    );
    expect(authenticatedCookie).not.toBe(preLoginCookie);
    expect(registered.headers["set-cookie"]).toContain("HttpOnly");
    expect(registered.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(registered.headers["set-cookie"]).toContain("Path=/");
    expect(registered.headers["set-cookie"]).not.toContain("Domain=");
    expect(registered.body).not.toContain(PASSWORD);
    expect(registered.json()).toMatchObject({
      user: {
        accountState: "ACTIVE",
        adultAttestedAt: NOW.toISOString(),
        id: USER_ID,
      },
    });
    await expect(
      fixture.persistence.findCredentialByEmail("person@example.com"),
    ).resolves.toMatchObject({ passwordHash: `hash:${PASSWORD}` });

    const oldSession = await fixture.app.inject({
      headers: { cookie: preLoginCookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    expect(oldSession.statusCode).toBe(401);

    const session = await fixture.app.inject({
      headers: { cookie: authenticatedCookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    expect(session.statusCode).toBe(200);
    const sessionToken = session.json<{ csrfToken: string }>().csrfToken;

    const logout = await fixture.app.inject({
      headers: {
        cookie: authenticatedCookie,
        "x-csrf-token": sessionToken,
      },
      method: "POST",
      url: AUTH_API_PATHS.logout,
    });
    expect(logout.statusCode).toBe(204);
    expect(
      await fixture.app.inject({
        headers: { cookie: authenticatedCookie },
        method: "GET",
        url: AUTH_API_PATHS.session,
      }),
    ).toMatchObject({ statusCode: 401 });
  });

  it("fails registration closed when no eligibility adapter is injected", async () => {
    const fixture = createFixture();
    const session = await csrf(fixture.app);
    const response = await fixture.app.inject({
      headers: { cookie: session.cookie, "x-csrf-token": session.token },
      method: "POST",
      payload: {
        adultAttested: true,
        email: "person@example.com",
        password: PASSWORD,
      },
      url: AUTH_API_PATHS.register,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "REGISTRATION_NOT_AVAILABLE" });
    expect(
      await fixture.persistence.findCredentialByEmail("person@example.com"),
    ).toBeUndefined();
  });

  it("fails reset delivery closed without persisting an undeliverable token", async () => {
    const fixture = createFixture({ delivery: false, eligible: true });
    await register(fixture);
    const session = await csrf(fixture.app);

    const response = await requestReset(fixture, session);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(fixture.persistence.resetDigests()).toEqual([]);
  });

  it("returns the same response for a wrong password and unknown account", async () => {
    const fixture = createFixture({ eligible: true });
    await register(fixture);

    const wrong = await login(
      fixture,
      "person@example.com",
      "Wrong password 12345",
    );
    const unknown = await login(
      fixture,
      "nobody@example.com",
      "Wrong password 12345",
    );

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.json()).toEqual({ code: "INVALID_CREDENTIALS" });
    expect(fixture.hasher.verifications).toHaveLength(2);
  });

  it("enforces suspension against an already-open session", async () => {
    const fixture = createFixture({ eligible: true });
    const registered = await register(fixture);
    fixture.persistence.setAccountState(USER_ID, "SUSPENDED");

    const response = await fixture.app.inject({
      headers: { cookie: registered.cookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "ACCOUNT_NOT_ACTIVE" });
    const rejectedLogin = await login(fixture, "person@example.com", PASSWORD);
    expect(rejectedLogin.statusCode).toBe(401);
    expect(rejectedLogin.json()).toEqual({ code: "INVALID_CREDENTIALS" });
  });

  it("rejects expired and payload-tampered sessions", async () => {
    const expiredFixture = createFixture({ eligible: true });
    const expiredRegistration = await register(expiredFixture);
    expiredFixture.advance(7 * 24 * 60 * 60 * 1000 + 1);
    expect(
      await expiredFixture.app.inject({
        headers: { cookie: expiredRegistration.cookie },
        method: "GET",
        url: AUTH_API_PATHS.session,
      }),
    ).toMatchObject({ statusCode: 401 });

    const tamperedFixture = createFixture({ eligible: true });
    const tamperedRegistration = await register(tamperedFixture);
    tamperedFixture.persistence.tamperAuthenticatedSessionBinding();
    expect(
      await tamperedFixture.app.inject({
        headers: { cookie: tamperedRegistration.cookie },
        method: "GET",
        url: AUTH_API_PATHS.session,
      }),
    ).toMatchObject({ statusCode: 401 });
  });

  it("rejects missing, wrong, and cross-session CSRF tokens", async () => {
    const fixture = createFixture({ eligible: true });
    const first = await csrf(fixture.app);
    const second = await csrf(fixture.app);
    const request = (cookie: string, token?: string) =>
      fixture.app.inject({
        headers: {
          cookie,
          ...(token === undefined ? {} : { "x-csrf-token": token }),
        },
        method: "POST",
        payload: { email: "person@example.com", password: PASSWORD },
        url: AUTH_API_PATHS.login,
      });

    for (const response of [
      await request(first.cookie),
      await request(first.cookie, "wrong-token"),
      await request(first.cookie, second.token),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "CSRF_INVALID" });
    }
  });

  it("keeps reset requests generic and makes reset tokens single-use", async () => {
    const fixture = createFixture({ eligible: true });
    const registered = await register(fixture);
    const knownSession = await csrf(fixture.app);
    const unknownSession = await csrf(fixture.app);
    const known = await fixture.app.inject({
      headers: {
        cookie: knownSession.cookie,
        "x-csrf-token": knownSession.token,
      },
      method: "POST",
      payload: { email: "person@example.com" },
      url: AUTH_API_PATHS.passwordResetRequest,
    });
    const unknown = await fixture.app.inject({
      headers: {
        cookie: unknownSession.cookie,
        "x-csrf-token": unknownSession.token,
      },
      method: "POST",
      payload: { email: "nobody@example.com" },
      url: AUTH_API_PATHS.passwordResetRequest,
    });

    expect(known.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    expect(known.body).not.toContain(RESET_TOKEN);
    expect(fixture.deliveries).toEqual([
      { normalizedEmail: "person@example.com", token: RESET_TOKEN },
    ]);
    expect(fixture.persistence.resetDigests()).toEqual([
      createHash("sha256").update(RESET_TOKEN).digest("hex"),
    ]);

    const resetSession = await csrf(fixture.app);
    const reset = await confirmReset(fixture, resetSession, RESET_TOKEN);
    expect(reset.statusCode).toBe(204);
    expect(
      await fixture.app.inject({
        headers: { cookie: registered.cookie },
        method: "GET",
        url: AUTH_API_PATHS.session,
      }),
    ).toMatchObject({ statusCode: 401 });

    const replaySession = await csrf(fixture.app);
    const replay = await confirmReset(fixture, replaySession, RESET_TOKEN);
    const tamperedSession = await csrf(fixture.app);
    const tampered = await confirmReset(
      fixture,
      tamperedSession,
      `${RESET_TOKEN.slice(0, -1)}x`,
    );
    expect(replay.statusCode).toBe(400);
    expect(tampered.statusCode).toBe(400);
    expect(replay.body).toBe(tampered.body);
    expect(replay.json()).toEqual({ code: "INVALID_OR_EXPIRED_RESET" });

    expect(
      (await login(fixture, "person@example.com", PASSWORD)).statusCode,
    ).toBe(401);
    expect(
      (await login(fixture, "person@example.com", NEW_PASSWORD)).statusCode,
    ).toBe(200);
  });

  it("verifies email once and exposes only server-authoritative state", async () => {
    const fixture = createFixture({ eligible: true, emailVerification: true });
    const registered = await register(fixture);
    expect(registered.response.json()).toMatchObject({
      user: { emailVerified: false },
    });
    expect(fixture.emailDeliveries).toEqual([
      {
        normalizedEmail: "person@example.com",
        token: VERIFICATION_TOKENS[0],
      },
    ]);
    expect(fixture.emailVerificationPersistence.digests()).toEqual([
      createHash("sha256").update(VERIFICATION_TOKENS[0]).digest("hex"),
    ]);

    const verificationSession = await csrf(fixture.app);
    const verified = await confirmEmailVerification(
      fixture,
      verificationSession,
      VERIFICATION_TOKENS[0],
    );
    expect(verified.statusCode).toBe(204);
    expect(verified.body).not.toContain(VERIFICATION_TOKENS[0]);

    const authenticatedSession = await fixture.app.inject({
      headers: { cookie: registered.cookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    expect(authenticatedSession.json()).toMatchObject({
      user: { emailVerified: true },
    });
    const verifiedSessionCsrf = authenticatedSession.json<{
      csrfToken: string;
    }>().csrfToken;
    const postVerificationResend = await fixture.app.inject({
      headers: {
        cookie: registered.cookie,
        "x-csrf-token": verifiedSessionCsrf,
      },
      method: "POST",
      url: AUTH_API_PATHS.emailVerificationResend,
    });
    expect(postVerificationResend.statusCode).toBe(202);
    expect(postVerificationResend.json()).toEqual({ accepted: true });
    expect(fixture.emailDeliveries).toHaveLength(1);

    const replaySession = await csrf(fixture.app);
    const replay = await confirmEmailVerification(
      fixture,
      replaySession,
      VERIFICATION_TOKENS[0],
    );
    const tamperedSession = await csrf(fixture.app);
    const tampered = await confirmEmailVerification(
      fixture,
      tamperedSession,
      `${VERIFICATION_TOKENS[0].slice(0, -1)}x`,
    );
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toBe(tampered.body);
    expect(replay.json()).toEqual({
      code: "INVALID_OR_EXPIRED_VERIFICATION",
    });
  });

  it("sends and consumes a phone OTP once with server-authoritative state", async () => {
    const fixture = createFixture({ eligible: true, phoneVerification: true });
    const registered = await register(fixture);
    expect(registered.response.json()).toMatchObject({
      user: { phoneVerified: false },
    });
    const authenticated = await fixture.app.inject({
      headers: { cookie: registered.cookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    const token = authenticated.json<{ csrfToken: string }>().csrfToken;

    const sent = await fixture.app.inject({
      headers: {
        cookie: registered.cookie,
        "x-csrf-token": token,
      },
      method: "POST",
      payload: { phone: "+421 901 234 567" },
      url: AUTH_API_PATHS.phoneVerificationSend,
    });
    expect(sent.statusCode).toBe(202);
    const challengeId = sent.json<{ challengeId: string }>().challengeId;
    expect(challengeId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fixture.phoneDeliveries).toEqual([
      { normalizedPhone: "+421901234567", otp: "730981" },
    ]);
    expect(fixture.phoneVerificationPersistence.serialized()).not.toContain(
      "730981",
    );

    const verified = await fixture.app.inject({
      headers: {
        cookie: registered.cookie,
        "x-csrf-token": token,
      },
      method: "POST",
      payload: { challengeId, otp: "730981" },
      url: AUTH_API_PATHS.phoneVerificationVerify,
    });
    expect(verified.statusCode).toBe(204);
    const replay = await fixture.app.inject({
      headers: {
        cookie: registered.cookie,
        "x-csrf-token": token,
      },
      method: "POST",
      payload: { challengeId, otp: "730981" },
      url: AUTH_API_PATHS.phoneVerificationVerify,
    });
    const unknown = await fixture.app.inject({
      headers: {
        cookie: registered.cookie,
        "x-csrf-token": token,
      },
      method: "POST",
      payload: {
        challengeId: "0198ddec-56bd-7f4c-8752-1daa51fd9999",
        otp: "000000",
      },
      url: AUTH_API_PATHS.phoneVerificationVerify,
    });
    expect(replay.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(replay.body).toBe(unknown.body);
    expect(replay.json()).toEqual({
      code: "INVALID_OR_EXPIRED_VERIFICATION",
    });

    const refreshed = await fixture.app.inject({
      headers: { cookie: registered.cookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    expect(refreshed.json()).toMatchObject({
      user: { phoneVerified: true },
    });
  });

  it("fails phone delivery closed and enforces shared resend buckets", async () => {
    const unavailable = createFixture({
      eligible: true,
      phoneVerification: true,
      phoneVerificationDelivery: false,
    });
    const unavailableRegistration = await register(unavailable);
    const unavailableSession = await unavailable.app.inject({
      headers: { cookie: unavailableRegistration.cookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    const unavailableResponse = await unavailable.app.inject({
      headers: {
        cookie: unavailableRegistration.cookie,
        "x-csrf-token": unavailableSession.json<{ csrfToken: string }>()
          .csrfToken,
      },
      method: "POST",
      payload: { phone: "+421901234567" },
      url: AUTH_API_PATHS.phoneVerificationSend,
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailable.phoneVerificationPersistence.serialized()).toBe("[]");

    const limited = createFixture({
      config: { phoneOtpResendLimit: 1 },
      eligible: true,
      phoneVerification: true,
    });
    const limitedRegistration = await register(limited);
    const limitedSession = await limited.app.inject({
      headers: { cookie: limitedRegistration.cookie },
      method: "GET",
      url: AUTH_API_PATHS.session,
    });
    const headers = {
      cookie: limitedRegistration.cookie,
      "x-csrf-token": limitedSession.json<{ csrfToken: string }>().csrfToken,
    };
    const first = await limited.app.inject({
      headers,
      method: "POST",
      payload: { phone: "+421901234567" },
      url: AUTH_API_PATHS.phoneVerificationSend,
    });
    const second = await limited.app.inject({
      headers,
      method: "POST",
      payload: { phone: "+421 901 234 567" },
      url: AUTH_API_PATHS.phoneVerificationSend,
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(limited.phoneDeliveries).toHaveLength(1);
    expect(
      limited.persistence.rateCalls.some((call) =>
        call.startsWith("phone-otp-send:user:"),
      ),
    ).toBe(true);
    expect(
      limited.persistence.rateCalls.some((call) =>
        call.startsWith("phone-otp-send:ip:"),
      ),
    ).toBe(true);
    expect(
      limited.persistence.rateCalls.some((call) =>
        call.startsWith("phone-otp-send:phone:"),
      ),
    ).toBe(true);
  });

  it("expires email-verification tokens and blocks suspended accounts", async () => {
    const expiredFixture = createFixture({
      eligible: true,
      emailVerification: true,
    });
    await register(expiredFixture);
    expiredFixture.advance(24 * 60 * 60 * 1_000 + 1);
    const expiredSession = await csrf(expiredFixture.app);
    expect(
      await confirmEmailVerification(
        expiredFixture,
        expiredSession,
        VERIFICATION_TOKENS[0],
      ),
    ).toMatchObject({ statusCode: 400 });

    const suspendedFixture = createFixture({
      eligible: true,
      emailVerification: true,
    });
    const suspendedRegistration = await register(suspendedFixture);
    suspendedFixture.persistence.setAccountState(USER_ID, "SUSPENDED");
    const csrfToken = suspendedRegistration.response.json<{
      csrfToken: string;
    }>().csrfToken;
    expect(
      await suspendedFixture.app.inject({
        headers: {
          cookie: suspendedRegistration.cookie,
          "x-csrf-token": csrfToken,
        },
        method: "POST",
        url: AUTH_API_PATHS.emailVerificationResend,
      }),
    ).toMatchObject({ statusCode: 403 });
    const confirmSession = await csrf(suspendedFixture.app);
    expect(
      await confirmEmailVerification(
        suspendedFixture,
        confirmSession,
        VERIFICATION_TOKENS[0],
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it("rate-limits resend by account and supersedes the prior token", async () => {
    const fixture = createFixture({
      eligible: true,
      emailVerification: true,
      verificationResendLimit: 1,
    });
    const registered = await register(fixture);
    const csrfToken = registered.response.json<{ csrfToken: string }>()
      .csrfToken;
    const resend = () =>
      fixture.app.inject({
        headers: {
          cookie: registered.cookie,
          "x-csrf-token": csrfToken,
        },
        method: "POST",
        url: AUTH_API_PATHS.emailVerificationResend,
      });

    const first = await resend();
    const second = await resend();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true });
    expect(second.statusCode).toBe(429);
    expect(fixture.emailDeliveries).toHaveLength(2);

    const staleSession = await csrf(fixture.app);
    expect(
      await confirmEmailVerification(
        fixture,
        staleSession,
        VERIFICATION_TOKENS[0],
      ),
    ).toMatchObject({ statusCode: 400 });
    const liveSession = await csrf(fixture.app);
    expect(
      await confirmEmailVerification(
        fixture,
        liveSession,
        VERIFICATION_TOKENS[1],
      ),
    ).toMatchObject({ statusCode: 204 });
  });

  it("fails resend closed without creating an undeliverable token", async () => {
    const fixture = createFixture({
      eligible: true,
      emailVerification: true,
      emailVerificationDelivery: false,
    });
    const registered = await register(fixture);
    const csrfToken = registered.response.json<{ csrfToken: string }>()
      .csrfToken;
    const response = await fixture.app.inject({
      headers: {
        cookie: registered.cookie,
        "x-csrf-token": csrfToken,
      },
      method: "POST",
      url: AUTH_API_PATHS.emailVerificationResend,
    });

    expect(response.statusCode).toBe(503);
    expect(fixture.emailVerificationPersistence.digests()).toEqual([]);
  });

  it("rejects expired reset tokens and allows only one concurrent consumer", async () => {
    const fixture = createFixture({ eligible: true });
    await register(fixture);
    const requestSession = await csrf(fixture.app);
    await requestReset(fixture, requestSession);
    fixture.advance(60 * 60 * 1000 + 1);
    const resetSession = await csrf(fixture.app);
    expect(
      (await confirmReset(fixture, resetSession, RESET_TOKEN)).statusCode,
    ).toBe(400);

    fixture.rewind();
    const replacementSession = await csrf(fixture.app);
    await requestReset(fixture, replacementSession);
    const digest = createHash("sha256").update(RESET_TOKEN).digest("hex");
    const outcomes = await Promise.all([
      fixture.persistence.consumePasswordReset({
        newPasswordHash: "hash:first",
        now: NOW,
        tokenDigest: digest,
      }),
      fixture.persistence.consumePasswordReset({
        newPasswordHash: "hash:second",
        now: NOW,
        tokenDigest: digest,
      }),
    ]);
    expect(outcomes.sort()).toEqual(["INVALID", "UPDATED"]);
  });

  it("sets the production host cookie and exact credentialed CORS", async () => {
    const fixture = createFixture({
      config: {
        cookieName: "__Host-portal.sid",
        cookieSecure: true,
        trustProxyHops: 1,
      },
      eligible: true,
    });
    const response = await fixture.app.inject({
      headers: {
        origin: "https://portal.example",
        "x-forwarded-proto": "https",
      },
      method: "GET",
      url: AUTH_API_PATHS.csrf,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://portal.example",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["set-cookie"]).toContain("__Host-portal.sid=");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).not.toContain("Domain=");

    const crossOrigin = await fixture.app.inject({
      headers: { origin: "https://attacker.example" },
      method: "GET",
      url: AUTH_API_PATHS.csrf,
    });
    expect(crossOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("shares rate-limit state and resets it after the window", async () => {
    const fixture = createFixture({
      config: { rateLimitMax: 1, rateLimitWindowMs: 1_000 },
    });
    const firstSession = await csrf(fixture.app);
    const first = await fixture.app.inject({
      headers: {
        cookie: firstSession.cookie,
        "x-csrf-token": firstSession.token,
      },
      method: "POST",
      payload: { email: "nobody@example.com", password: PASSWORD },
      url: AUTH_API_PATHS.login,
    });
    const secondSession = await csrf(fixture.app);
    const second = await fixture.app.inject({
      headers: {
        cookie: secondSession.cookie,
        "x-csrf-token": secondSession.token,
      },
      method: "POST",
      payload: { email: "nobody@example.com", password: PASSWORD },
      url: AUTH_API_PATHS.login,
    });
    expect(first.statusCode).toBe(401);
    expect(fixture.persistence.rateCalls.length).toBeGreaterThanOrEqual(4);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ code: "RATE_LIMITED" });

    fixture.advance(1_001);
    const thirdSession = await csrf(fixture.app);
    expect(
      await fixture.app.inject({
        headers: {
          cookie: thirdSession.cookie,
          "x-csrf-token": thirdSession.token,
        },
        method: "POST",
        payload: { email: "nobody@example.com", password: PASSWORD },
        url: AUTH_API_PATHS.login,
      }),
    ).toMatchObject({ statusCode: 401 });

    const Store = createPostgresRateLimitStoreConstructor({
      clock: fixture.clock,
      persistence: fixture.persistence,
    });
    const storeA = new Store({});
    const storeB = new Store({});
    await increment(storeA, "shared-client", 1_000, 2);
    expect(await increment(storeB, "shared-client", 1_000, 2)).toMatchObject({
      current: 2,
    });
  });
});

describe("authentication primitives and adapters", () => {
  it("uses Argon2id and rejects the wrong password", async () => {
    const hasher = createArgon2PasswordHasher();
    const hash = await hasher.hash(PASSWORD);

    expect(hash).toMatch(/^\$argon2id\$/u);
    await expect(hasher.verify(hash, PASSWORD)).resolves.toBe(true);
    await expect(hasher.verify(hash, "Wrong password 12345")).resolves.toBe(
      false,
    );
  });

  it("hashes opaque session IDs before calling the database repository", async () => {
    let observed = "";
    const repository = {
      findSession(sessionIdHash: string) {
        observed = sessionIdHash;
        return Promise.resolve(null);
      },
    } as AuthRepository;
    const persistence = createAuthPersistence(repository);

    await persistence.readSession("raw-session-secret", NOW);

    expect(observed).toBe(
      createHash("sha256").update("raw-session-secret").digest("hex"),
    );
    expect(observed).not.toContain("raw-session-secret");
  });

  it("reconstructs cookie security policy instead of trusting DB payload", async () => {
    const persistence = new MemoryAuthPersistence();
    await persistence.writeSession({
      expiresAt: new Date(NOW.valueOf() + 60_000),
      id: "opaque-session-id",
      payload: {
        authUserId: USER_ID,
        cookie: {
          domain: "attacker.example",
          httpOnly: false,
          path: "/downgraded",
          sameSite: "none",
          secure: false,
        },
      },
      userId: USER_ID,
    });
    const store = createPostgresSessionStore({
      clock: () => NOW,
      cookieSecure: true,
      persistence,
      sessionTtlMs: 60_000,
    });

    const session = await getStoredSession(store, "opaque-session-id");

    expect(session?.cookie).toMatchObject({
      expires: new Date(NOW.valueOf() + 60_000),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
    expect(session?.cookie).not.toHaveProperty("domain");
    expect(session?.authUserId).toBe(USER_ID);
  });
});

interface Fixture {
  readonly app: ReturnType<typeof buildApi>;
  readonly clock: () => Date;
  readonly deliveries: { normalizedEmail: string; token: string }[];
  readonly draftCreations: PersistCreateDraftWithInitialSectionInput[];
  readonly emailDeliveries: { normalizedEmail: string; token: string }[];
  readonly emailVerificationPersistence: MemoryEmailVerificationPersistence;
  readonly hasher: FakeHasher;
  readonly persistence: MemoryAuthPersistence;
  readonly phoneDeliveries: { normalizedPhone: string; otp: string }[];
  readonly phoneVerificationPersistence: MemoryPhoneVerificationPersistence;
  advance(milliseconds: number): void;
  rewind(): void;
}

function createFixture(
  options: {
    readonly config?: Partial<AuthRuntimeConfig>;
    readonly delivery?: boolean;
    readonly draftHandoff?: boolean;
    readonly emailVerification?: boolean;
    readonly emailVerificationDelivery?: boolean;
    readonly eligible?: boolean;
    readonly phoneVerification?: boolean;
    readonly phoneVerificationDelivery?: boolean;
    readonly verificationResendLimit?: number;
  } = {},
): Fixture {
  let now = NOW;
  const clock = () => now;
  const persistence = new MemoryAuthPersistence();
  const hasher = new FakeHasher();
  const deliveries: { normalizedEmail: string; token: string }[] = [];
  const draftCreations: PersistCreateDraftWithInitialSectionInput[] = [];
  const emailDeliveries: { normalizedEmail: string; token: string }[] = [];
  const phoneDeliveries: { normalizedPhone: string; otp: string }[] = [];
  const emailVerificationPersistence = new MemoryEmailVerificationPersistence(
    persistence,
    clock,
  );
  const phoneVerificationPersistence = new MemoryPhoneVerificationPersistence(
    persistence,
    clock,
  );
  const eligibility: RegistrationEligibilityPort | undefined =
    options.eligible === undefined
      ? undefined
      : {
          isEligible: () => Promise.resolve(options.eligible === true),
        };
  const config: AuthRuntimeConfig = {
    appOrigin: "https://portal.example",
    cookieName: "portal.sid",
    cookieSecure: false,
    passwordResetTtlMs: 60 * 60 * 1000,
    rateLimitMax: 100,
    rateLimitWindowMs: 15 * 60 * 1000,
    sessionSecret: "test-only-session-secret-with-at-least-32-characters",
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    trustProxyHops: 0,
    ...options.config,
  };
  const tokens: ResetTokenService = {
    digest: (token) => createHash("sha256").update(token).digest("hex"),
    generate: () => RESET_TOKEN,
  };
  let verificationTokenIndex = 0;
  const verificationTokens: EmailVerificationTokenService = {
    digest: (token) => createHash("sha256").update(token).digest("hex"),
    generate: () => {
      const token = VERIFICATION_TOKENS[verificationTokenIndex];
      verificationTokenIndex += 1;
      if (token === undefined) throw new Error("Verification token exhausted");
      return token;
    },
  };
  let phoneSaltIndex = 0;
  const phoneCrypto: PhoneOtpCrypto = {
    digest: ({ otp, salt }) =>
      createHash("sha256").update(`${salt}\0${otp}`).digest("hex"),
    generateOtp: () => "730981",
    generateSalt: () =>
      createHash("sha256")
        .update(`phone-salt-${phoneSaltIndex++}`)
        .digest("hex")
        .slice(0, 32),
  };
  const app = buildApi({
    auth: {
      clock,
      config,
      ...(options.delivery === false
        ? {}
        : {
            delivery: {
              deliver(input: { normalizedEmail: string; token: string }) {
                deliveries.push(input);
                return Promise.resolve();
              },
            },
          }),
      ...(eligibility === undefined ? {} : { eligibility }),
      ...(options.draftHandoff === true
        ? {
            draftHandoff: {
              customerProfiles: {
                ensureForCustomerUse: () =>
                  Promise.resolve({
                    profile: {
                      createdAt: NOW,
                      id: "97000000-0000-4000-8000-000000000098" as CustomerProfileId,
                      ownerUserId: USER_ID,
                      publicVisibility: "PRIVATE" as const,
                      searchIndexing: "DISALLOWED" as const,
                      updatedAt: NOW,
                    },
                    status: "CREATED" as const,
                  }),
              },
              drafts: {
                createDraftWithInitialSectionOwned: (
                  input: PersistCreateDraftWithInitialSectionInput,
                ) => {
                  const first = draftCreations[0];
                  draftCreations.push(input);
                  if (
                    first !== undefined &&
                    (first.commandId !== input.commandId ||
                      first.section.canonicalPayload !==
                        input.section.canonicalPayload)
                  ) {
                    return Promise.reject(
                      new JobRequestDraftIdempotencyError(),
                    );
                  }
                  return Promise.resolve({
                    jobRequestId:
                      "97000000-0000-4000-8000-000000000099" as JobRequestId,
                    ...(first === undefined
                      ? { status: "APPLIED" as const }
                      : {
                          originalStatus: "APPLIED" as const,
                          status: "DEDUPLICATED" as const,
                        }),
                    revision: 1,
                    savedAt: NOW,
                  });
                },
              },
            },
          }
        : {}),
      ...(options.emailVerification === true
        ? {
            emailVerification: {
              ...(options.emailVerificationDelivery === false
                ? {}
                : {
                    delivery: {
                      deliver(input: {
                        normalizedEmail: string;
                        token: string;
                      }) {
                        emailDeliveries.push(input);
                        return Promise.resolve();
                      },
                    },
                  }),
              persistence: emailVerificationPersistence,
              resendLimit: options.verificationResendLimit ?? 10,
              tokenTtlMs: 24 * 60 * 60 * 1_000,
              tokens: verificationTokens,
            },
          }
        : {}),
      hasher,
      persistence,
      ...(options.phoneVerification === true
        ? {
            phoneVerification: {
              crypto: phoneCrypto,
              ...(options.phoneVerificationDelivery === false
                ? {}
                : {
                    delivery: {
                      deliver(input: { normalizedPhone: string; otp: string }) {
                        phoneDeliveries.push(input);
                        return Promise.resolve();
                      },
                    },
                  }),
              persistence: phoneVerificationPersistence,
            },
          }
        : {}),
      tokens,
    },
    database: { ping: () => Promise.resolve() },
  });
  openApps.push(app);
  return {
    advance(milliseconds) {
      now = new Date(now.valueOf() + milliseconds);
    },
    app,
    clock,
    deliveries,
    draftCreations,
    emailDeliveries,
    emailVerificationPersistence,
    hasher,
    persistence,
    phoneDeliveries,
    phoneVerificationPersistence,
    rewind() {
      now = NOW;
    },
  };
}

class FakeHasher implements PasswordHasher {
  public readonly verifications: { hash: string; password: string }[] = [];

  public hash(password: string): Promise<string> {
    return Promise.resolve(`hash:${password}`);
  }

  public verify(hash: string, password: string): Promise<boolean> {
    this.verifications.push({ hash, password });
    return Promise.resolve(hash === `hash:${password}`);
  }
}

class MemoryAuthPersistence implements AuthPersistence {
  public readonly rateCalls: string[] = [];
  private readonly buckets = new Map<
    string,
    { current: number; expiresAt: Date }
  >();
  private readonly credentials = new Map<string, AuthCredential>();
  private readonly resets = new Map<
    string,
    { expiresAt: Date; used: boolean; userId: UserId }
  >();
  private readonly sessions = new Map<string, StoredSession>();

  public consumePasswordReset(input: {
    newPasswordHash: string;
    now: Date;
    tokenDigest: string;
  }): Promise<"INVALID" | "UPDATED"> {
    const reset = this.resets.get(input.tokenDigest);
    if (
      reset === undefined ||
      reset.used ||
      reset.expiresAt.valueOf() <= input.now.valueOf()
    ) {
      return Promise.resolve("INVALID");
    }
    reset.used = true;
    for (const [email, credential] of this.credentials) {
      if (credential.id === reset.userId) {
        this.credentials.set(email, {
          ...credential,
          passwordHash: input.newPasswordHash,
        });
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.userId === reset.userId) {
        this.sessions.delete(id);
      }
    }
    return Promise.resolve("UPDATED");
  }

  public consumeRateLimit(input: {
    keyDigest: string;
    limit: number;
    now: Date;
    scope: string;
    timeWindowMs: number;
  }): Promise<{ current: number; ttlMs: number }> {
    const key = `${input.scope}:${input.keyDigest}`;
    this.rateCalls.push(key);
    const prior = this.buckets.get(key);
    if (
      prior === undefined ||
      prior.expiresAt.valueOf() <= input.now.valueOf()
    ) {
      const expiresAt = new Date(input.now.valueOf() + input.timeWindowMs);
      this.buckets.set(key, { current: 1, expiresAt });
      return Promise.resolve({ current: 1, ttlMs: input.timeWindowMs });
    }
    prior.current += 1;
    return Promise.resolve({
      current: prior.current,
      ttlMs: prior.expiresAt.valueOf() - input.now.valueOf(),
    });
  }

  public createPasswordReset(input: {
    expiresAt: Date;
    tokenDigest: string;
    userId: UserId;
  }): Promise<void> {
    for (const [digest, reset] of this.resets) {
      if (reset.userId === input.userId && !reset.used) {
        this.resets.delete(digest);
      }
    }
    this.resets.set(input.tokenDigest, { ...input, used: false });
    return Promise.resolve();
  }

  public destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  public findCredentialByEmail(
    normalizedEmail: string,
  ): Promise<AuthCredential | undefined> {
    return Promise.resolve(this.credentials.get(normalizedEmail));
  }

  public findUserById(userId: UserId): Promise<AuthUser | undefined> {
    return Promise.resolve(
      [...this.credentials.values()].find(
        (credential) => credential.id === userId,
      ),
    );
  }

  public readSession(
    sessionId: string,
    now: Date,
  ): Promise<StoredSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined && session.expiresAt.valueOf() <= now.valueOf()) {
      this.sessions.delete(sessionId);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(session);
  }

  public register(input: {
    adultAttested: true;
    normalizedEmail: string;
    passwordHash: string;
  }): Promise<{ status: "CREATED"; user: AuthUser } | { status: "DUPLICATE" }> {
    if (this.credentials.has(input.normalizedEmail)) {
      return Promise.resolve({ status: "DUPLICATE" });
    }
    const credential: AuthCredential = {
      accountState: "ACTIVE",
      adultAttestedAt: NOW,
      emailVerifiedAt: null,
      id: USER_ID,
      passwordHash: input.passwordHash,
      phoneVerifiedAt: null,
    };
    this.credentials.set(input.normalizedEmail, credential);
    return Promise.resolve({ status: "CREATED", user: credential });
  }

  public resetDigests(): string[] {
    return [...this.resets.keys()];
  }

  public revokeAllSessions(userId: UserId): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(id);
      }
    }
    return Promise.resolve();
  }

  public setAccountState(userId: UserId, state: UserAccountState): void {
    for (const [email, credential] of this.credentials) {
      if (credential.id === userId) {
        this.credentials.set(email, { ...credential, accountState: state });
      }
    }
  }

  public markEmailVerified(userId: UserId, verifiedAt: Date): boolean {
    for (const [email, credential] of this.credentials) {
      if (credential.id === userId) {
        this.credentials.set(email, {
          ...credential,
          emailVerifiedAt: credential.emailVerifiedAt ?? verifiedAt,
        });
        return true;
      }
    }
    return false;
  }

  public markPhoneVerified(userId: UserId, verifiedAt: Date): boolean {
    for (const [email, credential] of this.credentials) {
      if (credential.id === userId) {
        this.credentials.set(email, {
          ...credential,
          phoneVerifiedAt: credential.phoneVerifiedAt ?? verifiedAt,
        });
        return true;
      }
    }
    return false;
  }

  public verificationTarget(userId: UserId): AuthCredential | undefined {
    return [...this.credentials.values()].find(
      (credential) => credential.id === userId,
    );
  }

  public tamperAuthenticatedSessionBinding(): void {
    for (const [id, session] of this.sessions) {
      if (session.userId !== undefined) {
        this.sessions.set(id, {
          ...session,
          payload: {
            ...session.payload,
            authUserId: `${USER_ID.slice(0, -4)}9999`,
          },
        });
      }
    }
  }

  public writeSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }
}

class MemoryEmailVerificationPersistence implements EmailVerificationPersistence {
  private readonly records = new Map<
    string,
    { expiresAt: Date; invalidated: boolean; used: boolean; userId: UserId }
  >();

  public constructor(
    private readonly auth: MemoryAuthPersistence,
    private readonly clock: () => Date,
  ) {}

  public consume(tokenDigest: string): Promise<"INVALID" | "VERIFIED"> {
    const record = this.records.get(tokenDigest);
    const target =
      record === undefined
        ? undefined
        : this.auth.verificationTarget(record.userId);
    if (
      record === undefined ||
      record.invalidated ||
      record.used ||
      record.expiresAt.valueOf() <= this.clock().valueOf() ||
      target?.accountState !== "ACTIVE"
    ) {
      return Promise.resolve("INVALID");
    }
    record.used = true;
    return Promise.resolve(
      this.auth.markEmailVerified(record.userId, this.clock())
        ? "VERIFIED"
        : "INVALID",
    );
  }

  public digests(): string[] {
    return [...this.records.keys()];
  }

  public issue(input: {
    expiresAt: Date;
    tokenDigest: string;
    userId: UserId;
  }): Promise<
    { normalizedEmail: string; status: "ISSUED" } | { status: "NOT_ELIGIBLE" }
  > {
    const target = this.auth.verificationTarget(input.userId);
    if (
      target === undefined ||
      target.accountState !== "ACTIVE" ||
      target.emailVerifiedAt !== null
    ) {
      return Promise.resolve({ status: "NOT_ELIGIBLE" });
    }
    for (const record of this.records.values()) {
      if (record.userId === input.userId && !record.used) {
        record.invalidated = true;
      }
    }
    this.records.set(input.tokenDigest, {
      ...input,
      invalidated: false,
      used: false,
    });
    return Promise.resolve({
      normalizedEmail: "person@example.com",
      status: "ISSUED",
    });
  }
}

class MemoryPhoneVerificationPersistence implements PhoneVerificationPersistence {
  private readonly records = new Map<
    string,
    {
      attempts: number;
      expiresAt: Date;
      invalidated: boolean;
      maxAttempts: number;
      normalizedPhone: string;
      otpDigest: string;
      otpSalt: string;
      used: boolean;
      userId: UserId;
    }
  >();

  public constructor(
    private readonly auth: MemoryAuthPersistence,
    private readonly clock: () => Date,
  ) {}

  public findDigestMaterial(input: {
    challengeId: string;
    userId: UserId;
  }): Promise<{ otpSalt: string } | null> {
    const record = this.live(input);
    return Promise.resolve(
      record === null ? null : { otpSalt: record.otpSalt },
    );
  }

  public invalidate(input: {
    challengeId: string;
    userId: UserId;
  }): Promise<void> {
    const record = this.records.get(input.challengeId);
    if (record?.userId === input.userId && !record.used) {
      record.invalidated = true;
    }
    return Promise.resolve();
  }

  public issue(input: {
    challengeId: string;
    expiresAt: Date;
    maxAttempts: number;
    normalizedPhone: string;
    otpDigest: string;
    otpSalt: string;
    userId: UserId;
  }): Promise<"ISSUED" | "NOT_ELIGIBLE"> {
    const target = this.auth.verificationTarget(input.userId);
    if (target?.accountState !== "ACTIVE" || target.phoneVerifiedAt !== null) {
      return Promise.resolve("NOT_ELIGIBLE");
    }
    for (const record of this.records.values()) {
      if (record.userId === input.userId && !record.used) {
        record.invalidated = true;
      }
    }
    this.records.set(input.challengeId, {
      ...input,
      attempts: 0,
      invalidated: false,
      used: false,
    });
    return Promise.resolve("ISSUED");
  }

  public serialized(): string {
    return JSON.stringify([...this.records.values()]);
  }

  public verifyAttempt(input: {
    challengeId: string;
    otpDigest: string;
    userId: UserId;
  }): Promise<"INVALID" | "VERIFIED"> {
    const record = this.live(input);
    if (record === null) return Promise.resolve("INVALID");
    record.attempts += 1;
    if (record.otpDigest !== input.otpDigest) {
      if (record.attempts >= record.maxAttempts) record.invalidated = true;
      return Promise.resolve("INVALID");
    }
    record.used = true;
    return Promise.resolve(
      this.auth.markPhoneVerified(input.userId, this.clock())
        ? "VERIFIED"
        : "INVALID",
    );
  }

  private live(input: { challengeId: string; userId: UserId }) {
    const record = this.records.get(input.challengeId);
    const target = this.auth.verificationTarget(input.userId);
    if (
      record === undefined ||
      record.userId !== input.userId ||
      target?.accountState !== "ACTIVE" ||
      record.invalidated ||
      record.used ||
      record.attempts >= record.maxAttempts ||
      record.expiresAt.valueOf() <= this.clock().valueOf()
    ) {
      return null;
    }
    return record;
  }
}

async function csrf(app: ReturnType<typeof buildApi>) {
  const response = await app.inject({
    method: "GET",
    url: AUTH_API_PATHS.csrf,
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: responseCookie(response.headers["set-cookie"]),
    token: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function register(fixture: Fixture) {
  const session = await csrf(fixture.app);
  const response = await fixture.app.inject({
    headers: { cookie: session.cookie, "x-csrf-token": session.token },
    method: "POST",
    payload: {
      adultAttested: true,
      email: "person@example.com",
      password: PASSWORD,
    },
    url: AUTH_API_PATHS.register,
  });
  expect(response.statusCode).toBe(201);
  return { cookie: responseCookie(response.headers["set-cookie"]), response };
}

async function login(fixture: Fixture, email: string, password: string) {
  const session = await csrf(fixture.app);
  return fixture.app.inject({
    headers: { cookie: session.cookie, "x-csrf-token": session.token },
    method: "POST",
    payload: { email, password },
    url: AUTH_API_PATHS.login,
  });
}

async function requestReset(
  fixture: Fixture,
  session: { cookie: string; token: string },
) {
  return fixture.app.inject({
    headers: { cookie: session.cookie, "x-csrf-token": session.token },
    method: "POST",
    payload: { email: "person@example.com" },
    url: AUTH_API_PATHS.passwordResetRequest,
  });
}

async function confirmReset(
  fixture: Fixture,
  session: { cookie: string; token: string },
  token: string,
) {
  return fixture.app.inject({
    headers: { cookie: session.cookie, "x-csrf-token": session.token },
    method: "POST",
    payload: { newPassword: NEW_PASSWORD, token },
    url: AUTH_API_PATHS.passwordReset,
  });
}

async function confirmEmailVerification(
  fixture: Fixture,
  session: { cookie: string; token: string },
  token: string,
) {
  return fixture.app.inject({
    headers: { cookie: session.cookie, "x-csrf-token": session.token },
    method: "POST",
    payload: { token },
    url: AUTH_API_PATHS.emailVerification,
  });
}

function responseCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    throw new Error("Expected a session cookie");
  }
  return value.split(";", 1)[0] ?? "";
}

function increment(
  store: {
    incr(
      key: string,
      callback: (
        error: Error | null,
        result?: { current: number; ttl: number },
      ) => void,
      timeWindow: number,
      max: number,
    ): void;
  },
  key: string,
  window: number,
  max: number,
): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.incr(
      key,
      (error, result) => {
        if (error !== null || result === undefined) {
          reject(error ?? new Error("Missing rate-limit result"));
          return;
        }
        resolve(result);
      },
      window,
      max,
    );
  });
}

function getStoredSession(
  store: ReturnType<typeof createPostgresSessionStore>,
  sessionId: string,
) {
  return new Promise<Session | null>((resolve, reject) => {
    store.get(sessionId, (error, session) => {
      if (error !== null && error !== undefined) {
        reject(
          error instanceof Error
            ? error
            : new Error("Session store read failed"),
        );
        return;
      }
      resolve(session ?? null);
    });
  });
}
