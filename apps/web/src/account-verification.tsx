"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
  type AuthOnboardingSession,
} from "./auth-onboarding-client";
import { AuthPageShell } from "./auth-page-shell";
import {
  ActionLink,
  Button,
  Card,
  FormField,
  Input,
  Notice,
  StatusBadge,
  Stepper,
} from "./design-system";

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
  const currentStep = !session.user.emailVerified
    ? 1
    : !session.user.phoneVerified
      ? 2
      : 3;
  return (
    <AuthPageShell
      eyebrow="Bezpečný účet"
      lead="Pred odoslaním dopytu alebo reakciou na pozvánku potrebujeme overiť e-mail aj telefón."
      title="Dokončite overenie účtu"
    >
      <Stepper current={currentStep} steps={["E-mail", "Telefón", "Hotovo"]} />
      <div className="verification-list">
        <Card>
          <header>
            <h2>E-mail</h2>
            <StatusBadge
              tone={session.user.emailVerified ? "success" : "warning"}
            >
              {session.user.emailVerified ? "Overený" : "Čaká na overenie"}
            </StatusBadge>
          </header>
          <p>
            {session.user.emailVerified
              ? "E-mail je overený."
              : "Otvorte overovací odkaz, ktorý sme poslali na e-mail z vášho účtu."}
          </p>
          {session.user.emailVerified ? null : (
            <Button
              disabled={busy}
              onClick={() => void resendEmail()}
              type="button"
              variant="secondary"
            >
              Poslať overovací e-mail znova
            </Button>
          )}
        </Card>
        <Card>
          <header>
            <h2>Telefón</h2>
            <StatusBadge
              tone={session.user.phoneVerified ? "success" : "warning"}
            >
              {session.user.phoneVerified ? "Overený" : "Čaká na overenie"}
            </StatusBadge>
          </header>
          <p>
            {session.user.phoneVerified
              ? "Telefón je overený."
              : "Na zadané číslo pošleme jednorazový šesťmiestny kód."}
          </p>
          {session.user.phoneVerified ? null : challengeId === null ? (
            <div className="login-form">
              <FormField
                description="Zadajte číslo, ku ktorému máte prístup."
                label="Telefónne číslo"
              >
                <Input
                  autoComplete="tel"
                  id="verification-phone"
                  maxLength={32}
                  onChange={(event) => setPhone(event.target.value)}
                  required
                  type="tel"
                  value={phone}
                />
              </FormField>
              <Button
                disabled={busy}
                onClick={() => void sendPhone()}
                type="button"
              >
                Poslať overovací kód
              </Button>
            </div>
          ) : (
            <div className="login-form">
              <FormField
                description="Kód je jednorazový a má obmedzenú platnosť."
                label="Šesťmiestny kód"
              >
                <Input
                  autoComplete="one-time-code"
                  id="verification-otp"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setOtp(event.target.value)}
                  pattern="[0-9]{6}"
                  required
                  value={otp}
                />
              </FormField>
              <Button
                disabled={busy}
                onClick={() => void verifyPhone()}
                type="button"
              >
                Overiť telefón
              </Button>
            </div>
          )}
        </Card>
      </div>
      {message === "" ? null : (
        <Notice title="Stav overenia" tone="trust">
          <p aria-live="polite" role="status">
            {message}
          </p>
        </Notice>
      )}
      <div className="onboarding-actions">
        <Button
          disabled={busy}
          onClick={() => void refresh()}
          type="button"
          variant="quiet"
        >
          Obnoviť stav overenia
        </Button>
        {ready ? (
          <Notice title="Účet je pripravený" tone="success">
            <p>
              Overenie je dokončené. Teraz môžete pokračovať v rozpracovanom
              dopyte.
            </p>
            <ActionLink href="/dopyt">Pokračovať v dopyte</ActionLink>
          </Notice>
        ) : null}
      </div>
    </AuthPageShell>
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
    <AuthPageShell
      eyebrow="Bezpečný účet"
      lead="Overenie e-mailu a telefónu chráni obe strany pri práci s dopytmi a pozvánkami."
      title="Overenie účtu"
    >
      <Notice title="Stav účtu" tone="trust">
        <p aria-live="polite">{text}</p>
      </Notice>
      {action === undefined ? null : (
        <div className="onboarding-actions">
          <ActionLink href={action}>{actionLabel}</ActionLink>
        </div>
      )}
      {onRetry === undefined ? null : (
        <div className="onboarding-actions">
          <Button onClick={onRetry} type="button">
            Skúsiť znova
          </Button>
        </div>
      )}
    </AuthPageShell>
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
