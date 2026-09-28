"use client";

import React, { useMemo, useState, type FormEvent } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
} from "./auth-onboarding-client";

export function RegistrationForm({
  client,
}: {
  readonly client?: AuthOnboardingClient;
}) {
  const auth = useMemo(() => client ?? createAuthOnboardingClient(), [client]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [adultAttested, setAdultAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) {
      setMessage("Heslá sa nezhodujú.");
      return;
    }
    if (!adultAttested) {
      setMessage("Pre registráciu potvrďte vek aspoň 18 rokov.");
      return;
    }
    setBusy(true);
    setMessage("");
    const result = await auth.register({ email, password });
    if (result.status === "REGISTERED") {
      window.location.assign("/overenie");
      return;
    }
    setMessage(
      result.status === "REGISTRATION_NOT_AVAILABLE"
        ? "Registrácia pre tento e-mail nie je dostupná. Skontrolujte pozvánku alebo sa obráťte na podporu."
        : result.status === "RATE_LIMITED"
          ? "Príliš veľa pokusov. Skúste to neskôr."
          : result.status === "INVALID_REQUEST"
            ? "Skontrolujte e-mail, heslo a potvrdenie veku."
            : "Registrácia teraz nie je dostupná. Skúste to znova neskôr.",
    );
    setBusy(false);
  }

  return (
    <main className="login-page">
      <section className="login-shell">
        <p className="eyebrow">Web Alpha</p>
        <h1>Registrácia do Web Alpha</h1>
        <p>Vytvorte si účet iba s e-mailom, ktorý dostal pozvánku.</p>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="registration-email">E-mail</label>
          <input
            autoComplete="email"
            id="registration-email"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <label htmlFor="registration-password">Heslo</label>
          <input
            aria-describedby="registration-password-hint"
            autoComplete="new-password"
            id="registration-password"
            maxLength={128}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <small id="registration-password-hint">
            Použite aspoň 12 znakov.
          </small>
          <label htmlFor="registration-confirmation">Zopakujte heslo</label>
          <input
            autoComplete="new-password"
            id="registration-confirmation"
            maxLength={128}
            minLength={12}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
          <label className="checkbox-row" htmlFor="adult-attestation">
            <input
              checked={adultAttested}
              id="adult-attestation"
              onChange={(event) => setAdultAttested(event.target.checked)}
              required
              type="checkbox"
            />
            <span>Potvrdzujem, že mám aspoň 18 rokov.</span>
          </label>
          {message === "" ? null : <p role="alert">{message}</p>}
          <button disabled={busy} type="submit">
            {busy ? "Vytváram účet…" : "Vytvoriť účet"}
          </button>
        </form>
        <p className="onboarding-links">
          Už máte účet? <a href="/prihlasenie">Prihláste sa.</a>
        </p>
      </section>
    </main>
  );
}
