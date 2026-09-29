"use client";

import React, { useMemo, useState, type FormEvent } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
  type AuthOnboardingSession,
} from "./auth-onboarding-client";
import { AuthPageShell } from "./auth-page-shell";
import { ActionLink, Button, FormField, Input, Notice } from "./design-system";

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
    <AuthPageShell
      eyebrow="Váš účet"
      lead="Prihláste sa a pokračujte tam, kde ste skončili. Rozpracovaný dopyt zostane zachovaný."
      title="Vitajte späť"
    >
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <FormField label="E-mail">
          <Input
            autoComplete="username"
            id="login-email"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </FormField>
        <FormField label="Heslo">
          <Input
            autoComplete="current-password"
            id="login-password"
            maxLength={128}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </FormField>
        {message === "" ? null : (
          <Notice title="Prihlásenie sa nepodarilo" tone="error">
            <p role="alert">{message}</p>
          </Notice>
        )}
        <Button disabled={busy} type="submit">
          {busy ? "Prihlasujem…" : "Prihlásiť sa a pokračovať"}
        </Button>
      </form>
      <div className="onboarding-links">
        <p>Máte pozvánku, ale ešte nemáte účet?</p>
        <ActionLink href="/registracia" variant="secondary">
          Zaregistrovať sa s pozvánkou
        </ActionLink>
      </div>
    </AuthPageShell>
  );
}

export function loginDestination(session: AuthOnboardingSession): string {
  return session.user.emailVerified && session.user.phoneVerified
    ? "/dopyt"
    : "/overenie";
}
