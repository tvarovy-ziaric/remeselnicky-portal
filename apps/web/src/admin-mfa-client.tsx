"use client";

import { ADMIN_AUTH_API_PATHS, AUTH_API_PATHS } from "@portal/contracts";
import { useMemo, useState, type FormEvent } from "react";

export interface AdminMfaChallenge {
  readonly challengeToken: string;
  readonly factorKind: "TOTP" | "WEBAUTHN";
  readonly publicChallenge: string | null;
}

export type AdminMfaBeginResult =
  | {
      readonly challenge: AdminMfaChallenge;
      readonly status: "CHALLENGE_CREATED";
    }
  | {
      readonly status:
        | "ACCESS_DENIED"
        | "AUTHENTICATION_REQUIRED"
        | "RATE_LIMITED"
        | "UNAVAILABLE";
    };

export type AdminMfaVerifyResult =
  | "ACCESS_DENIED"
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_RESPONSE"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "VERIFIED";

export interface AdminMfaClient {
  beginChallenge(): Promise<AdminMfaBeginResult>;
  verify(input: {
    readonly challengeToken: string;
    readonly factorKind: AdminMfaChallenge["factorKind"];
    readonly response: string;
  }): Promise<AdminMfaVerifyResult>;
}

export function createAdminMfaClient(
  input: {
    readonly fetch?: typeof fetch;
    readonly reload?: () => void;
  } = {},
): AdminMfaClient {
  const fetcher = input.fetch ?? fetch;
  const reload = input.reload ?? (() => window.location.reload());

  return Object.freeze<AdminMfaClient>({
    async beginChallenge(): Promise<AdminMfaBeginResult> {
      const csrfToken = await loadCsrf(fetcher);
      if (csrfToken === null) return { status: "UNAVAILABLE" };
      try {
        const response = await fetcher(ADMIN_AUTH_API_PATHS.challenge, {
          body: JSON.stringify({ purpose: "PRIVILEGED_SESSION" }),
          cache: "no-store",
          credentials: "same-origin",
          headers: writeHeaders(csrfToken),
          method: "POST",
        });
        if (response.status === 401)
          return { status: "AUTHENTICATION_REQUIRED" };
        if (response.status === 403) return { status: "ACCESS_DENIED" };
        if (response.status === 429) return { status: "RATE_LIMITED" };
        if (!response.ok) return { status: "UNAVAILABLE" };
        const challenge = parseAdminMfaChallengeResponse(await response.json());
        return challenge === null
          ? { status: "UNAVAILABLE" }
          : { challenge, status: "CHALLENGE_CREATED" };
      } catch {
        return { status: "UNAVAILABLE" };
      }
    },

    async verify(verification): Promise<AdminMfaVerifyResult> {
      if (!validVerification(verification)) return "INVALID_RESPONSE";
      const csrfToken = await loadCsrf(fetcher);
      if (csrfToken === null) return "UNAVAILABLE";
      try {
        const response = await fetcher(ADMIN_AUTH_API_PATHS.verify, {
          body: JSON.stringify({
            challengeToken: verification.challengeToken,
            response: verification.response,
          }),
          cache: "no-store",
          credentials: "same-origin",
          headers: writeHeaders(csrfToken),
          method: "POST",
        });
        if (response.status === 204) {
          reload();
          return "VERIFIED";
        }
        return mapVerifyFailure(response);
      } catch {
        return "UNAVAILABLE";
      }
    },
  });
}

export function parseAdminMfaChallengeResponse(
  value: unknown,
): AdminMfaChallenge | null {
  if (
    !exactRecord(value, ["challengeToken", "factorKind", "publicChallenge"]) ||
    typeof value.challengeToken !== "string" ||
    !/^[A-Za-z0-9_-]{40,128}$/u.test(value.challengeToken) ||
    (value.factorKind !== "TOTP" && value.factorKind !== "WEBAUTHN") ||
    (value.factorKind === "TOTP"
      ? value.publicChallenge !== null
      : !boundedPrintable(value.publicChallenge, 1, 8_192))
  )
    return null;
  return value.factorKind === "TOTP"
    ? Object.freeze({
        challengeToken: value.challengeToken,
        factorKind: value.factorKind,
        publicChallenge: null,
      })
    : Object.freeze({
        challengeToken: value.challengeToken,
        factorKind: value.factorKind,
        publicChallenge: value.publicChallenge as string,
      });
}

export function AdminMfaEntry({
  client,
}: Readonly<{ readonly client?: AdminMfaClient }>) {
  const mfa = useMemo(() => client ?? createAdminMfaClient(), [client]);
  const [challenge, setChallenge] = useState<AdminMfaChallenge | null>(null);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setChallenge(null);
    setResponse("");
    setMessage(null);
    const result = await mfa.beginChallenge();
    if (result.status === "CHALLENGE_CREATED") {
      if (result.challenge.factorKind === "TOTP") {
        setChallenge(result.challenge);
      } else {
        setMessage(
          "Účet používa WebAuthn. Bezpečný browser adapter sa zapojí spolu so schváleným MFA providerom.",
        );
      }
    } else {
      setMessage(beginMessage(result.status));
    }
    setBusy(false);
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || challenge === null || challenge.factorKind !== "TOTP") return;
    setBusy(true);
    setMessage(null);
    const result = await mfa.verify({
      challengeToken: challenge.challengeToken,
      factorKind: challenge.factorKind,
      response,
    });
    setResponse("");
    if (result !== "VERIFIED") {
      // Every verification attempt consumes the one-shot server challenge.
      setChallenge(null);
      setMessage(verifyMessage(result));
    }
    setBusy(false);
  };

  return (
    <div className="admin-mfa-entry">
      {challenge === null ? (
        <button disabled={busy} type="button" onClick={() => void begin()}>
          {busy ? "Pripravujem MFA…" : "Pokračovať cez MFA"}
        </button>
      ) : (
        <form onSubmit={(event) => void verify(event)}>
          <label htmlFor="admin-mfa-response">Jednorazový MFA kód</label>
          <input
            autoComplete="one-time-code"
            id="admin-mfa-response"
            inputMode="numeric"
            maxLength={10}
            minLength={6}
            pattern="[0-9]{6,10}"
            required
            type="text"
            value={response}
            onChange={(event) => setResponse(event.target.value)}
          />
          <button
            disabled={busy || !/^\d{6,10}$/u.test(response)}
            type="submit"
          >
            {busy ? "Overujem…" : "Overiť a otvoriť administráciu"}
          </button>
        </form>
      )}
      {message === null ? null : <p role="alert">{message}</p>}
      <p>
        MFA kód ani challenge sa neukladajú do prehliadača. Každý neúspešný
        pokus vyžaduje nový challenge.
      </p>
    </div>
  );
}

async function loadCsrf(fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(AUTH_API_PATHS.csrf, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return exactRecord(body, ["csrfToken"]) &&
      boundedPrintable(body.csrfToken, 1, 1_000)
      ? body.csrfToken
      : null;
  } catch {
    return null;
  }
}

async function mapVerifyFailure(
  response: Response,
): Promise<Exclude<AdminMfaVerifyResult, "VERIFIED">> {
  if (response.status === 429) return "RATE_LIMITED";
  if (response.status === 403) return "ACCESS_DENIED";
  if (response.status !== 401) return "UNAVAILABLE";
  try {
    const body: unknown = await response.json();
    if (!exactRecord(body, ["code"])) return "UNAVAILABLE";
    if (body.code === "AUTHENTICATION_REQUIRED")
      return "AUTHENTICATION_REQUIRED";
    return body.code === "MFA_INVALID" ? "INVALID_RESPONSE" : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function validVerification(input: {
  readonly challengeToken: string;
  readonly factorKind: AdminMfaChallenge["factorKind"];
  readonly response: string;
}): boolean {
  if (!/^[A-Za-z0-9_-]{40,128}$/u.test(input.challengeToken)) return false;
  return input.factorKind === "TOTP"
    ? /^\d{6,10}$/u.test(input.response)
    : boundedPrintable(input.response, 1, 8_192);
}

function writeHeaders(csrfToken: string) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-csrf-token": csrfToken,
  } as const;
}

function beginMessage(
  status: Exclude<AdminMfaBeginResult["status"], "CHALLENGE_CREATED">,
): string {
  return status === "AUTHENTICATION_REQUIRED"
    ? "Najprv sa prihláste bežným administrátorským účtom."
    : status === "ACCESS_DENIED"
      ? "MFA challenge sa pre túto reláciu nepodarilo vydať."
      : status === "RATE_LIMITED"
        ? "Príliš veľa MFA pokusov. Počkajte a skúste to znova."
        : "MFA overenie teraz nie je dostupné.";
}

function verifyMessage(status: AdminMfaVerifyResult): string {
  return status === "AUTHENTICATION_REQUIRED"
    ? "Bežná prihlasovacia relácia vypršala. Prihláste sa znova."
    : status === "ACCESS_DENIED"
      ? "MFA overenie nemá potrebné oprávnenie."
      : status === "RATE_LIMITED"
        ? "Príliš veľa MFA pokusov. Počkajte a začnite nový challenge."
        : status === "INVALID_RESPONSE"
          ? "MFA odpoveď nebola platná. Začnite nový challenge."
          : "MFA overenie sa nepodarilo. Začnite nový challenge.";
}

function boundedPrintable(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[\x20-\x7e]+$/u.test(value)
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
