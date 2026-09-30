"use client";

import React, { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
} from "./auth-onboarding-client";
import { AuthPageShell } from "./auth-page-shell";
import { ActionLink, Button, FormField, Input, Notice } from "./design-system";

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
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => setHydrated(true), []);

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
    <AuthPageShell
      eyebrow="Web Alpha na pozvanie"
      lead="Vytvorte si jeden účet pre zákaznícke aj remeselnícke aktivity. Použite e-mail, na ktorý prišla pozvánka."
      title="Vytvorte si účet"
    >
      <Notice title="Registrácia je len na pozvanie" tone="trust">
        <p>Ak pozvánku nemáte, registráciu zatiaľ nie je možné dokončiť.</p>
      </Notice>
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <FormField label="E-mail z pozvánky">
          <Input
            autoComplete="email"
            id="registration-email"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </FormField>
        <FormField description="Použite aspoň 12 znakov." label="Heslo">
          <Input
            autoComplete="new-password"
            id="registration-password"
            maxLength={128}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </FormField>
        <FormField label="Zopakujte heslo">
          <Input
            autoComplete="new-password"
            id="registration-confirmation"
            maxLength={128}
            minLength={12}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
        </FormField>
        <label className="checkbox-row" htmlFor="adult-attestation">
          <Input
            checked={adultAttested}
            id="adult-attestation"
            onChange={(event) => setAdultAttested(event.target.checked)}
            required
            type="checkbox"
          />
          <span>Potvrdzujem, že mám aspoň 18 rokov.</span>
        </label>
        {message === "" ? null : (
          <Notice title="Účet sa nepodarilo vytvoriť" tone="error">
            <p role="alert">{message}</p>
          </Notice>
        )}
        <Button disabled={busy || !hydrated} type="submit">
          {busy ? "Vytváram účet…" : "Vytvoriť účet"}
        </Button>
      </form>
      <div className="onboarding-links">
        <p>Už máte účet?</p>
        <ActionLink href="/prihlasenie" variant="quiet">
          Prihlásiť sa
        </ActionLink>
      </div>
    </AuthPageShell>
  );
}
