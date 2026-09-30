import { describe, expect, it, vi } from "vitest";

import {
  createAuthOnboardingClient,
  parseAuthSessionResponse,
} from "./auth-onboarding-client";

const session = {
  csrfToken: "csrf-token-with-safe-length",
  user: {
    accountState: "ACTIVE",
    adultAttestedAt: "2026-09-28T08:00:00.000Z",
    emailVerified: false,
    id: "97000000-0000-4000-8000-000000000201",
    phoneVerified: false,
  },
} as const;

describe("auth onboarding client", () => {
  it("strictly parses the authoritative session without accepting extra fields", () => {
    expect(parseAuthSessionResponse(session)).toEqual(session);
    expect(
      parseAuthSessionResponse({ ...session, token: "secret" }),
    ).toBeNull();
    expect(
      parseAuthSessionResponse({
        ...session,
        user: { ...session.user, email: "private@example.test" },
      }),
    ).toBeNull();
  });

  it("registers with exact fields, same-origin credentials and CSRF", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ csrfToken: "csrf-token-with-safe-length" }),
      )
      .mockResolvedValueOnce(Response.json(session, { status: 201 }));
    const client = createAuthOnboardingClient({ fetch: fetcher });

    await expect(
      client.register({
        email: "  invited@example.test ",
        password: "long-password-123",
      }),
    ).resolves.toMatchObject({ status: "REGISTERED" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/auth/csrf");
    const [url, options] = fetcher.mock.calls[1] ?? [];
    expect(url).toBe("/v1/auth/register");
    expect(options).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      adultAttested: true,
      email: "invited@example.test",
      password: "long-password-123",
    });
    expect(options?.headers).toMatchObject({
      "x-csrf-token": "csrf-token-with-safe-length",
    });
  });

  it("reconciles only an ambiguous registration failure through the session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ csrfToken: "csrf-token-with-safe-length" }),
      )
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(Response.json(session));

    await expect(
      createAuthOnboardingClient({ fetch: fetcher }).register({
        email: "invited@example.test",
        password: "long-password-123",
      }),
    ).resolves.toMatchObject({ status: "REGISTERED" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toBe("/v1/auth/session");
  });

  it("logs out with the current CSRF token and same-origin credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createAuthOnboardingClient({ fetch: fetcher });

    await expect(client.logout(session.csrfToken)).resolves.toEqual({
      status: "SIGNED_OUT",
    });
    expect(fetcher).toHaveBeenCalledWith("/v1/auth/logout", {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "x-csrf-token": session.csrfToken,
      },
      method: "POST",
    });
    await expect(client.logout("short")).resolves.toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("keeps token and OTP in exact request bodies and rejects malformed secrets locally", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ csrfToken: "csrf-token-with-safe-length" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            accepted: true,
            challengeId: "97000000-0000-4000-8000-000000000202",
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createAuthOnboardingClient({ fetch: fetcher });
    const token = "a".repeat(48);

    await expect(client.confirmEmail("short")).resolves.toEqual({
      status: "INVALID_OR_EXPIRED",
    });
    await expect(client.confirmEmail(token)).resolves.toEqual({
      status: "VERIFIED",
    });
    const sent = await client.sendPhone({
      csrfToken: session.csrfToken,
      phone: "+421900000001",
    });
    expect(sent).toEqual({
      challengeId: "97000000-0000-4000-8000-000000000202",
      status: "SENT",
    });
    await expect(
      client.verifyPhone({
        challengeId: "97000000-0000-4000-8000-000000000202",
        csrfToken: session.csrfToken,
        otp: "123456",
      }),
    ).resolves.toEqual({ status: "VERIFIED" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      token,
    });
    expect(JSON.parse(fetcher.mock.calls[3]?.[1]?.body as string)).toEqual({
      challengeId: "97000000-0000-4000-8000-000000000202",
      otp: "123456",
    });
  });
});
