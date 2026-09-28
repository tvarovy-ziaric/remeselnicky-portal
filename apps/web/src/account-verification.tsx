"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
  type AuthOnboardingSession,
} from "./auth-onboarding-client";

type LoadState =
  | "ACCOUNT_NOT_ACTIVE"
  | "AUTHENTICATION_REQUIRED"
  | "LOADING"
  | "READY"
  | "UNAVAILABLE";

export function AccountVerification({
  client,
}: {
  readonly client?: AuthOnboardingClient;
}) {
  const auth = useMemo(() => client ?? createAuthOnboardingClient(), [client]);
  const [state, setState] = useState<LoadState>("LOADING");
  const [session, setSession] = useState<AuthOnboardingSession | null>(null);
  const [phone, setPhone] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const result = await auth.loadSession();
    if (result.status === "READY") {
      setSession(result.session);
      setState("READY");
      return;
    }
    setSession(null);
    setState(result.status);
  }, [auth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function resendEmail() {
    if (busy || session === null) return;
    setBusy(true);
    setMessage("");
    const result = await auth.resendEmail(session.csrfToken);
    setMessage(
      result.status === "SENT"
        ? "Žiadosť o nový overovací e-mail bola prijatá."
        : failureMessage(result.status),
    );
    setBusy(false);
  }

  async function sendPhone() {
    if (busy || session === null) return;
    setBusy(true);
    setMessage("");
    const result = await auth.sendPhone({
      csrfToken: session.csrfToken,
      phone,
    });
    if (result.status === "SENT") {
      setChallengeId(result.challengeId);
      setOtp("");
      setMessage("Overovací kód bol vyžiadaný.");
    } else {
      setMessage(failureMessage(result.status));
    }
    setBusy(false);
  }

  async function verifyPhone() {
    if (busy || session === null || challengeId === null) return;
    setBusy(true);
    setMessage("");
    const result = await auth.verifyPhone({
      challengeId,
      csrfToken: session.csrfToken,
      otp,
    });
    if (result.status === "VERIFIED") {
      setChallengeId(null);
      setOtp("");
      setPhone("");
      setMessage("Telefón bol úspešne overený.");
      await refresh();
    } else {
      setMessage(failureMessage(result.status));
    }
    setBusy(false);
  }

  if (state === "LOADING")
    return <VerificationMessage text="Načítavam stav overenia…" />;
  if (state === "AUTHENTICATION_REQUIRED") {
    return (
      <VerificationMessage
        action="/prihlasenie"
        actionLabel="Prihlásiť sa"
        text="Pre pokračovanie sa prihláste."
      />
    );
  }
  if (state === "ACCOUNT_NOT_ACTIVE") {
    return (
      <VerificationMessage text="Tento účet momentálne nie je dostupný." />
    );
  }
  if (state === "UNAVAILABLE" || session === null) {
    return (
      <VerificationMessage
        onRetry={() => void refresh()}
        text="Stav účtu sa nepodarilo načítať."
      />
    );
  }

  const ready = session.user.emailVerified && session.user.phoneVerified;
  return (
    <main className="login-page">
      <section className="login-shell">
        <p className="eyebrow">Web Alpha</p>
        <h1>Overenie účtu</h1>
        <div className="verification-list">
          <section>
            <h2>E-mail</h2>
            <p>
              {session.user.emailVerified
                ? "E-mail je overený."
                : "E-mail ešte nie je overený."}
            </p>
            {session.user.emailVerified ? null : (
              <button
                disabled={busy}
                onClick={() => void resendEmail()}
                type="button"
              >
                Poslať overovací e-mail znova
              </button>
            )}
          </section>
          <section>
            <h2>Telefón</h2>
            <p>
              {session.user.phoneVerified
                ? "Telefón je overený."
                : "Telefón ešte nie je overený."}
            </p>
            {session.user.phoneVerified ? null : challengeId === null ? (
              <div className="login-form">
                <label htmlFor="verification-phone">Telefónne číslo</label>
                <input
                  autoComplete="tel"
                  id="verification-phone"
                  maxLength={32}
                  onChange={(event) => setPhone(event.target.value)}
                  required
                  type="tel"
                  value={phone}
                />
                <button
                  disabled={busy}
                  onClick={() => void sendPhone()}
                  type="button"
                >
                  Poslať overovací kód
                </button>
              </div>
            ) : (
              <div className="login-form">
                <label htmlFor="verification-otp">Šesťmiestny kód</label>
                <input
                  autoComplete="one-time-code"
                  id="verification-otp"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setOtp(event.target.value)}
                  pattern="[0-9]{6}"
                  required
                  value={otp}
                />
                <button
                  disabled={busy}
                  onClick={() => void verifyPhone()}
                  type="button"
                >
                  Overiť telefón
                </button>
              </div>
            )}
          </section>
        </div>
        {message === "" ? null : (
          <p aria-live="polite" role="alert">
            {message}
          </p>
        )}
        <div className="onboarding-actions">
          <button disabled={busy} onClick={() => void refresh()} type="button">
            Obnoviť stav overenia
          </button>
          {ready ? (
            <section>
              <h2>Účet je pripravený</h2>
              <a className="primary-action" href="/dopyt">
                Pokračovať na vytvorenie dopytu
              </a>
            </section>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function VerificationMessage({
  action,
  actionLabel,
  onRetry,
  text,
}: {
  readonly action?: string;
  readonly actionLabel?: string;
  readonly onRetry?: () => void;
  readonly text: string;
}) {
  return (
    <main className="login-page">
      <section className="login-shell">
        <p className="eyebrow">Web Alpha</p>
        <h1>Overenie účtu</h1>
        <p aria-live="polite">{text}</p>
        {action === undefined ? null : <a href={action}>{actionLabel}</a>}
        {onRetry === undefined ? null : (
          <button onClick={onRetry}>Skúsiť znova</button>
        )}
      </section>
    </main>
  );
}

function failureMessage(status: string): string {
  return status === "INVALID_OR_EXPIRED"
    ? "Overovací kód je neplatný alebo už vypršal."
    : status === "RATE_LIMITED"
      ? "Príliš veľa pokusov. Skúste to neskôr."
      : status === "INVALID_REQUEST"
        ? "Skontrolujte zadané údaje."
        : status === "AUTHENTICATION_REQUIRED"
          ? "Pre pokračovanie sa prihláste."
          : "Overenie teraz nie je dostupné. Skúste to znova neskôr.";
}
