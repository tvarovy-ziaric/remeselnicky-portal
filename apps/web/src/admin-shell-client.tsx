"use client";

import { useEffect, useState } from "react";

import {
  ADMIN_MODULE_PRESENTATION,
  type AdminConsoleModule,
  type AdminSessionView,
  parseAdminModule,
  parseAdminModules,
  parseAdminSession,
} from "./admin-shell-model";
import { AdminDisputeWorkspace, AdminJobOperations } from "./admin-operations";

export type AdminShellState =
  | { readonly status: "LOADING" }
  | { readonly status: "AUTHENTICATION_REQUIRED" }
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
          <h1>Remeselnícky portál</h1>
        </div>
        <div className="admin-session" aria-label="Privilegovaná relácia">
          <span>{state.session.roles.join(" + ")}</span>
          <small>MFA relácia aktívna</small>
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
        <main className="admin-main">
          {selected === undefined ? (
            <section
              className="admin-panel"
              aria-labelledby="admin-denied-title"
            >
              <p className="admin-kicker">Prístup odmietnutý</p>
              <h2 id="admin-denied-title">Táto sekcia nie je dostupná</h2>
              <p>
                Oprávnenie overuje server. Skontrolujte odkaz alebo požiadajte
                vlastníka systému o pridelenie potrebnej roly.
              </p>
              <a className="admin-primary-link" href="/admin">
                Späť na prehľad
              </a>
            </section>
          ) : selected.id === "disputes" ? (
            <AdminDisputeWorkspace />
          ) : selected.id === "jobs" ? (
            <AdminJobOperations />
          ) : (
            <AdminModulePlaceholder module={selected} />
          )}
        </main>
      </div>
    </div>
  );
}

function AdminModulePlaceholder({
  module,
}: Readonly<{ module: AdminConsoleModule }>) {
  return (
    <section className="admin-panel" aria-labelledby="admin-module-title">
      <p className="admin-kicker">Prevádzková fronta</p>
      <h2 id="admin-module-title">{module.label}</h2>
      <p>{module.description}</p>
      <div className="admin-empty-state" role="status">
        <strong>Modul je pripravený na bezpečné napojenie.</strong>
        <span>
          Dáta a akcie pribudnú v príslušnom doménovom tickete. Každá požiadavka
          bude znovu autorizovaná backendom.
        </span>
      </div>
    </section>
  );
}

function LockedAdminState({
  status,
}: Readonly<{
  status: Exclude<AdminShellState["status"], "AUTHORIZED">;
}>) {
  const copy =
    status === "LOADING"
      ? ["Overujem prístup", "Kontrolujeme aktívnu MFA reláciu."]
      : status === "AUTHENTICATION_REQUIRED"
        ? ["Prihlásenie je potrebné", "Prihláste sa a dokončite MFA overenie."]
        : status === "ACCESS_DENIED"
          ? [
              "Prístup nie je povolený",
              "Účet nemá aktívne oprávnenie administrátora.",
            ]
          : [
              "Administrácia je nedostupná",
              "Prístup sa nepodarilo bezpečne overiť. Skúste to neskôr.",
            ];
  return (
    <main className="admin-locked">
      <section aria-live="polite" aria-labelledby="admin-state-title">
        <p className="admin-kicker">Interná administrácia</p>
        <h1 id="admin-state-title">{copy[0]}</h1>
        <p>{copy[1]}</p>
      </section>
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
    if (sessionResponse.status === 403) return { status: "ACCESS_DENIED" };
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
