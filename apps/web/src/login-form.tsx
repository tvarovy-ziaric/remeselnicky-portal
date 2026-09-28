"use client";

import React, { useMemo, useState, type FormEvent } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
  type AuthOnboardingSession,
} from "./auth-onboarding-client";

export function LoginForm({
  client,
}: {
  readonly client?: AuthOnboardingClient;
}) {
  const auth = useMemo(() => client ?? createAuthOnboardingClient(), [client]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await auth.login({ email, password });
      if (result.status === "AUTHENTICATED") {
        window.location.assign(loginDestination(result.session));
        return;
      }
      setMessage(
        result.status === "INVALID_CREDENTIALS"
          ? "E-mail alebo heslo nie je správne."
          : result.status === "RATE_LIMITED"
            ? "Príliš veľa pokusov. Skúste to neskôr."
            : "Prihlásenie sa nepodarilo. Skúste to znova.",
      );
    } catch {
      setMessage("Prihlásenie teraz nie je dostupné. Skúste to znova neskôr.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-shell">
        <p className="eyebrow">Dopyt</p>
        <h1>Prihlásenie</h1>
        <p>Pokračujte účtom, ktorý má pozvánku do Web Alpha.</p>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="login-email">E-mail</label>
          <input
            autoComplete="username"
            id="login-email"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <label htmlFor="login-password">Heslo</label>
          <input
            autoComplete="current-password"
            id="login-password"
            maxLength={128}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {message === "" ? null : <p role="alert">{message}</p>}
          <button disabled={busy} type="submit">
            {busy ? "Prihlasujem…" : "Prihlásiť sa a pokračovať"}
          </button>
        </form>
        <p className="onboarding-links">
          <a href="/registracia">Nemáte účet? Zaregistrujte sa s pozvánkou.</a>
        </p>
      </section>
    </main>
  );
}

export function loginDestination(session: AuthOnboardingSession): string {
  return session.user.emailVerified && session.user.phoneVerified
    ? "/dopyt"
    : "/overenie";
}
