"use client";

import React, { useEffect, useMemo, useState } from "react";

import {
  createAuthOnboardingClient,
  type AuthOnboardingClient,
} from "./auth-onboarding-client";
import {
  ActionLink,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatusBadge,
} from "./design-system";

type AccountHomeState =
  | "AUTHENTICATION_REQUIRED"
  | "LOADING"
  | "READY"
  | "UNAVAILABLE"
  | "VERIFICATION_REQUIRED";

export function AccountHome({
  client,
}: Readonly<{ client?: AuthOnboardingClient }>) {
  const auth = useMemo(() => client ?? createAuthOnboardingClient(), [client]);
  const [state, setState] = useState<AccountHomeState>("LOADING");

  useEffect(() => {
    let active = true;
    void auth.loadSession().then((result) => {
      if (!active) return;
      if (result.status === "AUTHENTICATION_REQUIRED") {
        setState("AUTHENTICATION_REQUIRED");
        return;
      }
      if (result.status !== "READY") {
        setState("UNAVAILABLE");
        return;
      }
      setState(
        result.session.user.emailVerified && result.session.user.phoneVerified
          ? "READY"
          : "VERIFICATION_REQUIRED",
      );
    });
    return () => {
      active = false;
    };
  }, [auth]);

  if (state === "LOADING") return <p role="status">Načítavam váš účet…</p>;
  if (state === "AUTHENTICATION_REQUIRED")
    return (
      <EmptyState
        action={
          <ActionLink href="/prihlasenie?return=%2Fucet">
            Prihlásiť sa
          </ActionLink>
        }
        description={
          <p>Jeden účet sprístupňuje zákaznícke aj remeselnícke časti.</p>
        }
        title="Najprv sa prihláste"
      />
    );
  if (state === "VERIFICATION_REQUIRED")
    return (
      <Notice title="Dokončite overenie účtu" tone="warning">
        <p>Pred dopytom alebo prácou s pozvánkami overte e-mail aj telefón.</p>
        <ActionLink href="/overenie">Pokračovať v overení</ActionLink>
      </Notice>
    );
  if (state === "UNAVAILABLE")
    return (
      <Notice title="Účet sa nepodarilo načítať" tone="error">
        <p>Obnovte stránku a skúste to znova.</p>
      </Notice>
    );

  return (
    <div className="account-home">
      <PageHeader
        eyebrow="Jeden účet, dve možnosti"
        lead={
          <p>
            Vyberte, čo chcete teraz robiť. Medzi zákazníckou a remeselníckou
            časťou sa môžete kedykoľvek prepnúť v hlavičke.
          </p>
        }
        title="Kam chcete pokračovať?"
      />
      <div className="account-context-cards">
        <Card className="account-context-card">
          <StatusBadge tone="trust">Zákazník</StatusBadge>
          <h2>Potrebujem remeselníka</h2>
          <p>
            Vytvorte dopyt, vyberte vhodných remeselníkov a sledujte svoje
            zákazky.
          </p>
          <div className="account-context-card__actions">
            <ActionLink href="/dopyt">Pokračovať ako zákazník</ActionLink>
            <ActionLink href="/remeselnici" variant="secondary">
              Prezrieť remeselníkov
            </ActionLink>
          </div>
        </Card>
        <Card className="account-context-card">
          <StatusBadge tone="success">Remeselník</StatusBadge>
          <h2>Ponúkam remeselnícke služby</h2>
          <p>
            Vytvorte alebo doplňte profil, nastavte oblasť pôsobenia a potom
            pracujte s pozvánkami od zákazníkov.
          </p>
          <div className="account-context-card__actions">
            <ActionLink href="/ucet/profil-remeselnika">
              Pokračovať ako remeselník
            </ActionLink>
            <ActionLink href="/pozvanky" variant="secondary">
              Pozvánky k dopytom
            </ActionLink>
          </div>
        </Card>
      </div>
    </div>
  );
}
