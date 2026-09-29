"use client";

import { useEffect, useState } from "react";

import {
  ActionLink,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatusBadge,
} from "./design-system";

import {
  ADMIN_MODULE_PRESENTATION,
  type AdminConsoleModule,
  type AdminSessionView,
  parseAdminModule,
  parseAdminModules,
  parseAdminSession,
} from "./admin-shell-model";
import { AdminDisputeWorkspace, AdminJobOperations } from "./admin-operations";
import { AdminModerationWorkspace } from "./admin-moderation";
import { AdminProfileReviewWorkspace } from "./admin-profile-review";
import { AdminCredentialReviewWorkspace } from "./admin-credential-review";
import { AdminMfaEntry } from "./admin-mfa-client";

export type AdminShellState =
  | { readonly status: "LOADING" }
  | { readonly status: "AUTHENTICATION_REQUIRED" }
  | { readonly status: "MFA_REQUIRED" }
  | { readonly status: "ACCESS_DENIED" }
  | { readonly status: "UNAVAILABLE" }
  | {
      readonly modules: readonly AdminConsoleModule[];
      readonly session: AdminSessionView;
      readonly status: "AUTHORIZED";
    };

export function AdminShellClient({
  requestedModuleId,
}: Readonly<{ requestedModuleId: string }>) {
  const [state, setState] = useState<AdminShellState>({ status: "LOADING" });

  useEffect(() => {
    const controller = new AbortController();
    void loadAdminShell(requestedModuleId, controller.signal).then(
      (nextState) => {
        if (!controller.signal.aborted) setState(nextState);
      },
    );
    return () => controller.abort();
  }, [requestedModuleId]);

  if (state.status !== "AUTHORIZED") {
    return <LockedAdminState status={state.status} />;
  }

  const selected = state.modules.find(({ id }) => id === requestedModuleId);
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">Interná prevádzka</p>
          <strong>Remeselnícky portál</strong>
        </div>
        <div className="admin-session" aria-label="Privilegovaná relácia">
          <span>{state.session.roles.map(adminRoleLabel).join(" + ")}</span>
          <StatusBadge tone="trust">MFA relácia aktívna</StatusBadge>
        </div>
      </header>
      <div className="admin-workspace">
        <nav className="admin-nav" aria-label="Administrácia">
          {state.modules.map((module) => (
            <a
              aria-current={
                module.id === requestedModuleId ? "page" : undefined
              }
              href={
                module.id === "dashboard" ? "/admin" : `/admin/${module.id}`
              }
              key={module.id}
            >
              <span aria-hidden="true">
                {ADMIN_MODULE_PRESENTATION[module.id].icon}
              </span>
              {module.label}
            </a>
          ))}
        </nav>
        <main className="admin-main" id="main-content">
          {selected === undefined ? (
            <EmptyState
              action={<ActionLink href="/admin">Späť na prehľad</ActionLink>}
              description="Oprávnenie overuje server. Skontrolujte odkaz alebo požiadajte vlastníka systému o pridelenie potrebnej roly."
              title="Táto sekcia nie je dostupná"
            />
          ) : selected.id === "disputes" ? (
            <AdminDisputeWorkspace />
          ) : selected.id === "jobs" ? (
            <AdminJobOperations />
          ) : selected.id === "reports" ? (
            <AdminModerationWorkspace />
          ) : selected.id === "profiles" ? (
            <AdminProfileReviewWorkspace />
          ) : selected.id === "credentials" ? (
            <AdminCredentialReviewWorkspace />
          ) : selected.id === "dashboard" ? (
            <AdminOperationsOverview modules={state.modules} />
          ) : (
            <AdminModulePlaceholder module={selected} />
          )}
        </main>
      </div>
    </div>
  );
}

export function AdminOperationsOverview({
  modules,
}: Readonly<{ modules: readonly AdminConsoleModule[] }>) {
  const queues = modules.filter(
    (module) => module.id !== "dashboard" && module.id !== "audit",
  );
  return (
    <section className="admin-panel admin-queue-overview">
      <PageHeader
        eyebrow="Interná prevádzka"
        lead={
          <p>
            Vyberte konkrétnu frontu. Každý detail a každá akcia sa znovu
            autorizujú na serveri.
          </p>
        }
        title="Prevádzkové fronty"
      />
      <Notice title="Rozhodujte podľa dôkazov">
        <p>
          Hlásenie je signál, nie verdikt. Moderovanie, obchodné spory a
          výnimočné zásahy do zákaziek zostávajú oddelené auditované procesy.
        </p>
      </Notice>
      <div className="admin-queue-grid">
        {queues.length === 0 ? (
          <EmptyState
            description="Aktuálna rola nemá pridelenú žiadnu prevádzkovú frontu. Oprávnenia určuje server."
            title="Žiadna dostupná fronta"
          />
        ) : (
          queues.map((module) => (
            <Card className="admin-queue-card" key={module.id}>
              <p className="ui-eyebrow">Prevádzková fronta</p>
              <h2>{module.label}</h2>
              <p>{module.description}</p>
              <ActionLink href={`/admin/${module.id}`}>
                Otvoriť frontu
              </ActionLink>
            </Card>
          ))
        )}
      </div>
    </section>
  );
}

function adminRoleLabel(role: AdminSessionView["roles"][number]): string {
  return role === "SUPER_ADMIN" ? "Vlastník administrácie" : "Administrátor";
}

function AdminModulePlaceholder({
  module,
}: Readonly<{ module: AdminConsoleModule }>) {
  return (
    <section className="admin-panel">
      <PageHeader
        eyebrow="Prevádzková fronta"
        lead={<p>{module.description}</p>}
        title={module.label}
      />
      <EmptyState
        description="Dáta a akcie pribudnú v príslušnom doménovom tickete. Každá požiadavka bude znovu autorizovaná backendom."
        title="Modul je pripravený na bezpečné napojenie"
      />
    </section>
  );
}

export function LockedAdminState({
  status,
}: Readonly<{
  status: Exclude<AdminShellState["status"], "AUTHORIZED">;
}>) {
  const copy: readonly [string, string] =
    status === "LOADING"
      ? ["Overujem prístup", "Kontrolujeme aktívnu MFA reláciu."]
      : status === "AUTHENTICATION_REQUIRED"
        ? ["Prihlásenie je potrebné", "Prihláste sa a dokončite MFA overenie."]
        : status === "MFA_REQUIRED"
          ? [
              "Vyžaduje sa privilegované overenie",
              "Pokračujte cez MFA. Server po overení znovu vyhodnotí aktuálnu rolu a oprávnenia.",
            ]
          : status === "ACCESS_DENIED"
            ? [
                "Prístup nie je povolený",
                "Aktuálna relácia nemá oprávnenie pre požadovaný administrátorský modul.",
              ]
            : [
                "Administrácia je nedostupná",
                "Prístup sa nepodarilo bezpečne overiť. Skúste to neskôr.",
              ];
  return (
    <main className="admin-locked" id="main-content">
      <Card aria-live="polite">
        <PageHeader
          eyebrow="Interná administrácia"
          lead={<p>{copy[1]}</p>}
          title={copy[0]}
        />
        {status === "AUTHENTICATION_REQUIRED" ? (
          <ActionLink href="/prihlasenie">Prejsť na prihlásenie</ActionLink>
        ) : status === "MFA_REQUIRED" ? (
          <AdminMfaEntry />
        ) : null}
      </Card>
    </main>
  );
}

export async function loadAdminShell(
  requestedModuleId: string,
  signal: AbortSignal,
): Promise<AdminShellState> {
  try {
    const sessionResponse = await fetch("/v1/admin/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
    if (sessionResponse.status === 401)
      return { status: "AUTHENTICATION_REQUIRED" };
    if (sessionResponse.status === 403) return { status: "MFA_REQUIRED" };
    if (!sessionResponse.ok) return { status: "UNAVAILABLE" };
    const session = parseAdminSession(await sessionResponse.json());
    if (session === undefined) return { status: "UNAVAILABLE" };

    const consoleResponse = await fetch("/v1/admin/console", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
    if (consoleResponse.status === 401)
      return { status: "AUTHENTICATION_REQUIRED" };
    if (consoleResponse.status === 403) return { status: "ACCESS_DENIED" };
    if (!consoleResponse.ok) return { status: "UNAVAILABLE" };
    let modules = parseAdminModules(await consoleResponse.json());
    if (modules === undefined) return { status: "UNAVAILABLE" };
    if (requestedModuleId !== "dashboard") {
      const moduleResponse = await fetch(
        `/v1/admin/console/modules/${encodeURIComponent(requestedModuleId)}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal,
        },
      );
      if (moduleResponse.status === 401) {
        return { status: "AUTHENTICATION_REQUIRED" };
      }
      if (moduleResponse.status === 403 || moduleResponse.status === 404) {
        return { status: "ACCESS_DENIED" };
      }
      if (!moduleResponse.ok) return { status: "UNAVAILABLE" };
      const selected = parseAdminModule(
        await moduleResponse.json(),
        requestedModuleId,
      );
      if (selected === undefined) return { status: "UNAVAILABLE" };
      modules = modules.map((module) =>
        module.id === selected.id ? selected : module,
      );
      if (!modules.some(({ id }) => id === selected.id)) {
        return { status: "ACCESS_DENIED" };
      }
    }
    return { modules, session, status: "AUTHORIZED" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
