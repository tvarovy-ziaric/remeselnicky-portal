import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminMfaEntry,
  createAdminMfaClient,
  parseAdminMfaChallengeResponse,
  type AdminMfaClient,
} from "./admin-mfa-client";

const csrfToken = "csrf-token-with-safe-length";
const challengeToken = "challenge_token-".padEnd(43, "a");

afterEach(() => vi.unstubAllGlobals());

describe("admin MFA challenge parsing", () => {
  it("accepts only the exact factor-specific challenge DTO", () => {
    expect(
      parseAdminMfaChallengeResponse({
        challengeToken,
        factorKind: "TOTP",
        publicChallenge: null,
      }),
    ).toEqual({
      challengeToken,
      factorKind: "TOTP",
      publicChallenge: null,
    });
    expect(
      parseAdminMfaChallengeResponse({
        challengeToken,
        factorKind: "WEBAUTHN",
        publicChallenge: "provider-public-challenge",
      }),
    ).toEqual({
      challengeToken,
      factorKind: "WEBAUTHN",
      publicChallenge: "provider-public-challenge",
    });

    expect(
      parseAdminMfaChallengeResponse({
        challengeToken,
        factorKind: "TOTP",
        publicChallenge: null,
        providerState: "must-not-reach-the-browser",
      }),
    ).toBeNull();
    expect(
      parseAdminMfaChallengeResponse({
        challengeToken,
        factorKind: "TOTP",
        publicChallenge: "TOTP secrets are never public challenges",
      }),
    ).toBeNull();
    expect(
      parseAdminMfaChallengeResponse({
        challengeToken,
        factorKind: "WEBAUTHN",
        publicChallenge: null,
      }),
    ).toBeNull();
  });

  it("bounds opaque tokens and provider challenges", () => {
    for (const token of [
      "a".repeat(39),
      "a".repeat(129),
      `${"a".repeat(42)}!`,
    ]) {
      expect(
        parseAdminMfaChallengeResponse({
          challengeToken: token,
          factorKind: "TOTP",
          publicChallenge: null,
        }),
      ).toBeNull();
    }
    for (const publicChallenge of ["", "a".repeat(8_193)]) {
      expect(
        parseAdminMfaChallengeResponse({
          challengeToken,
          factorKind: "WEBAUTHN",
          publicChallenge,
        }),
      ).toBeNull();
    }
  });
});

describe("admin MFA browser client", () => {
  it("renders a deliberate MFA entry without exposing a credential field early", () => {
    vi.stubGlobal("React", React);
    const client: AdminMfaClient = {
      beginChallenge: vi.fn<AdminMfaClient["beginChallenge"]>(),
      verify: vi.fn<AdminMfaClient["verify"]>(),
    };
    const markup = renderToStaticMarkup(
      React.createElement(AdminMfaEntry, { client }),
    );

    expect(markup).toContain("Pokračovať cez MFA");
    expect(markup).toContain("neukladajú do prehliadača");
    expect(markup).not.toContain('autoComplete="one-time-code"');
  });

  it("gets an exact CSRF token and begins a privileged-session challenge", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(
        Response.json({
          challengeToken,
          factorKind: "TOTP",
          publicChallenge: null,
        }),
      );

    await expect(
      createAdminMfaClient({ fetch: fetcher }).beginChallenge(),
    ).resolves.toEqual({
      challenge: {
        challengeToken,
        factorKind: "TOTP",
        publicChallenge: null,
      },
      status: "CHALLENGE_CREATED",
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/v1/admin/auth/mfa/challenge", {
      body: JSON.stringify({ purpose: "PRIVILEGED_SESSION" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      method: "POST",
    });
  });

  it("fails closed on a malformed CSRF or challenge response", async () => {
    const badCsrf = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ csrfToken, unexpected: "not accepted" }),
      );
    await expect(
      createAdminMfaClient({ fetch: badCsrf }).beginChallenge(),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(badCsrf).toHaveBeenCalledTimes(1);

    const badChallenge = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(
        Response.json({
          challengeToken,
          factorKind: "TOTP",
          publicChallenge: null,
          secret: "must-not-be-tolerated",
        }),
      );
    await expect(
      createAdminMfaClient({ fetch: badChallenge }).beginChallenge(),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it.each([
    [401, { code: "AUTHENTICATION_REQUIRED" }, "AUTHENTICATION_REQUIRED"],
    [403, { code: "PRIVILEGED_ACCESS_DENIED" }, "ACCESS_DENIED"],
    [429, { code: "RATE_LIMITED" }, "RATE_LIMITED"],
    [503, { code: "TEMPORARILY_UNAVAILABLE" }, "UNAVAILABLE"],
  ] as const)(
    "maps challenge failure %s without exposing provider details",
    async (httpStatus, body, status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken }))
        .mockResolvedValueOnce(Response.json(body, { status: httpStatus }));

      await expect(
        createAdminMfaClient({ fetch: fetcher }).beginChallenge(),
      ).resolves.toEqual({ status });
    },
  );

  it("posts the exact TOTP response and reloads only after verification", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const reload = vi.fn();
    const client = createAdminMfaClient({ fetch: fetcher, reload });

    await expect(
      client.verify({
        challengeToken,
        factorKind: "TOTP",
        response: "123456",
      }),
    ).resolves.toBe("VERIFIED");

    expect(fetcher).toHaveBeenNthCalledWith(2, "/v1/admin/auth/mfa/verify", {
      body: JSON.stringify({ challengeToken, response: "123456" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      method: "POST",
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("passes through a bounded manual provider response without normalizing it", async () => {
    const manualResponse = " provider-assertion+/= ";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      createAdminMfaClient({ fetch: fetcher, reload: vi.fn() }).verify({
        challengeToken,
        factorKind: "WEBAUTHN",
        response: manualResponse,
      }),
    ).resolves.toBe("VERIFIED");
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      challengeToken,
      response: manualResponse,
    });
  });

  it.each(["12345", "12345678901", "abcdef", "12 456"])(
    "rejects an invalid TOTP response locally: %s",
    async (response) => {
      const fetcher = vi.fn<typeof fetch>();
      const reload = vi.fn();

      await expect(
        createAdminMfaClient({ fetch: fetcher, reload }).verify({
          challengeToken,
          factorKind: "TOTP",
          response,
        }),
      ).resolves.toBe("INVALID_RESPONSE");
      expect(fetcher).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, { code: "MFA_INVALID" }, "INVALID_RESPONSE"],
    [401, { code: "AUTHENTICATION_REQUIRED" }, "AUTHENTICATION_REQUIRED"],
    [403, { code: "ACCOUNT_NOT_ACTIVE" }, "ACCESS_DENIED"],
    [429, { code: "RATE_LIMITED" }, "RATE_LIMITED"],
    [503, { code: "INTERNAL_ERROR" }, "UNAVAILABLE"],
  ] as const)(
    "maps verification failure %s/%s without reloading",
    async (httpStatus, body, status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken }))
        .mockResolvedValueOnce(Response.json(body, { status: httpStatus }));
      const reload = vi.fn();

      await expect(
        createAdminMfaClient({ fetch: fetcher, reload }).verify({
          challengeToken,
          factorKind: "TOTP",
          response: "123456",
        }),
      ).resolves.toBe(status);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: "UNKNOWN_MFA_ERROR" },
    { code: "MFA_INVALID", unexpected: true },
    { error: "MFA_INVALID" },
  ])("fails closed on a non-exact 401 body: %j", async (body) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(Response.json(body, { status: 401 }));
    const reload = vi.fn();

    await expect(
      createAdminMfaClient({ fetch: fetcher, reload }).verify({
        challengeToken,
        factorKind: "TOTP",
        response: "123456",
      }),
    ).resolves.toBe("UNAVAILABLE");
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not persist the CSRF token, challenge token, or MFA response", async () => {
    const localSetItem = vi.fn();
    const sessionSetItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localSetItem });
    vi.stubGlobal("sessionStorage", { setItem: sessionSetItem });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(
        Response.json({
          challengeToken,
          factorKind: "TOTP",
          publicChallenge: null,
        }),
      )
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createAdminMfaClient({ fetch: fetcher, reload: vi.fn() });

    await client.beginChallenge();
    await client.verify({
      challengeToken,
      factorKind: "TOTP",
      response: "123456",
    });

    expect(localSetItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
  });

  it("treats provider/network failure as unavailable and never reloads", async () => {
    const reload = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockRejectedValueOnce(new Error("provider connection failed"));

    await expect(
      createAdminMfaClient({ fetch: fetcher, reload }).verify({
        challengeToken,
        factorKind: "WEBAUTHN",
        response: "manual-provider-response",
      }),
    ).resolves.toBe("UNAVAILABLE");
    expect(reload).not.toHaveBeenCalled();
  });
});
