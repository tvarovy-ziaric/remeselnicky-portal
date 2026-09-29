"use client";

import React, { useCallback, useEffect, useState } from "react";

import {
  Button,
  Card,
  EmptyState,
  FormField,
  Notice,
  Select,
  StatusBadge,
} from "./design-system";

const requestTypes = [
  "ACCESS",
  "RECTIFICATION",
  "ERASURE",
  "RESTRICTION",
  "PORTABILITY",
  "OBJECTION",
  "ACCOUNT_CLOSURE",
] as const;
type RequestType = (typeof requestTypes)[number];
const requestStates = [
  "RECEIVED",
  "IDENTITY_VERIFICATION_PENDING",
  "VERIFIED",
  "IN_REVIEW",
  "ACTION_REQUIRED",
  "COMPLETED",
  "REJECTED",
] as const;
type RequestState = (typeof requestStates)[number];

interface PrivacyRequestItem {
  readonly actionCode: string | null;
  readonly caseId: string;
  readonly deadlineAt: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly requestType: RequestType;
  readonly revision: number;
  readonly state: RequestState;
}
interface ClosureReadiness {
  readonly canRequestClosure: boolean;
  readonly executionBlockedByOpenObligations: boolean;
}
type LoadState =
  | { readonly status: "LOADING" | "ERROR" }
  | {
      readonly items: readonly PrivacyRequestItem[];
      readonly readiness: ClosureReadiness;
      readonly status: "READY";
    };

export function PrivacyCenter() {
  const [state, setState] = useState<LoadState>({ status: "LOADING" });
  const [requestType, setRequestType] = useState<RequestType>("ACCESS");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState({ status: "LOADING" });
    try {
      const [requestResponse, readinessResponse] = await Promise.all([
        fetch("/v1/me/privacy/requests", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
        fetch("/v1/me/privacy/account-closure/readiness", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      ]);
      const items = requestResponse.ok
        ? parsePrivacyRequests(await requestResponse.json())
        : null;
      const readiness = readinessResponse.ok
        ? parseClosureReadiness(await readinessResponse.json())
        : null;
      if (items === null || readiness === null)
        throw new Error("invalid privacy response");
      setState({ items, readiness, status: "READY" });
    } catch {
      setState({ status: "ERROR" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function submitRequest() {
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch("/v1/me/privacy/requests", {
        body: JSON.stringify({
          caseId: globalThis.crypto.randomUUID(),
          correlationId: globalThis.crypto.randomUUID(),
          eventId: globalThis.crypto.randomUUID(),
          requestType,
        }),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": await csrf(),
        },
        method: "POST",
      });
      if (!response.ok) throw new Error("privacy request failed");
      setNotice(
        requestType === "ACCOUNT_CLOSURE"
          ? "Žiadosť o zatvorenie účtu bola prijatá. Účet sa deaktivuje až po overení identity, kontrole otvorených záväzkov a administratívnom spracovaní."
          : "Žiadosť bola bezpečne prijatá na spracovanie.",
      );
      await reload();
    } catch {
      setNotice("Žiadosť sa nepodarilo odoslať. Skúste to znova.");
    } finally {
      setSubmitting(false);
    }
  }

  const closureRequestUnavailable =
    requestType === "ACCOUNT_CLOSURE" &&
    state.status === "READY" &&
    !state.readiness.canRequestClosure;

  return (
    <div className="privacy-center">
      <Notice title="Žiadosť spustí kontrolovaný proces" tone="trust">
        <p>
          Odoslanie žiadosti samo osebe nič okamžite nemaže ani nemení.
          Oprávnený správca najprv overí identitu a rozsah žiadosti.
        </p>
      </Notice>

      <div className="privacy-center__layout">
        <Card className="privacy-request-card privacy-request-form">
          <h2>Nová žiadosť</h2>
          <FormField
            description="Vyberte, čo chcete vyriešiť. Stav potom uvidíte v histórii."
            label="Typ žiadosti"
          >
            <Select
              id="privacy-request-type"
              value={requestType}
              onChange={(event) =>
                setRequestType(event.target.value as RequestType)
              }
            >
              {requestTypes.map((type) => (
                <option key={type} value={type}>
                  {requestTypeLabel(type)}
                </option>
              ))}
            </Select>
          </FormField>
          {requestType === "ACCOUNT_CLOSURE" ? (
            <Notice
              title="Zatvorenie účtu nie je okamžitý výmaz"
              tone="warning"
            >
              <p>
                Po overení sa samostatne posúdi deaktivácia účtu, anonymizácia
                alebo výmaz údajov. Zdieľaná história zákaziek sa nemaže
                kaskádovo.
              </p>
              {state.status === "READY" &&
              state.readiness.executionBlockedByOpenObligations ? (
                <p role="status">
                  Vykonanie je momentálne blokované aktívnou zákazkou alebo
                  otvoreným sporom. Žiadosť môžete odoslať už teraz a záväzky
                  dokončiť v existujúcom pracovnom postupe.
                </p>
              ) : null}
              {closureRequestUnavailable ? (
                <p role="status">
                  Novú žiadosť o zatvorenie účtu momentálne nemožno odoslať.
                </p>
              ) : null}
            </Notice>
          ) : null}
          <div className="privacy-request-card__actions">
            <Button
              disabled={
                submitting ||
                state.status === "LOADING" ||
                closureRequestUnavailable
              }
              type="button"
              onClick={() => void submitRequest()}
            >
              {submitting ? "Odosielam…" : "Odoslať žiadosť"}
            </Button>
          </div>
        </Card>

        <div
          aria-labelledby="privacy-history-title"
          className="privacy-history privacy-request-history"
          role="region"
        >
          <h2 id="privacy-history-title">Moje žiadosti</h2>
          {notice ? (
            <Notice title="Aktualizácia žiadosti" tone="trust">
              <p role="status">{notice}</p>
            </Notice>
          ) : null}
          {state.status === "LOADING" ? (
            <Notice title="Načítavam históriu" tone="trust">
              <p aria-live="polite">Načítavam žiadosti…</p>
            </Notice>
          ) : null}
          {state.status === "ERROR" ? (
            <Notice title="História nie je dostupná" tone="error">
              <p aria-live="polite">
                Súkromné žiadosti teraz nie sú dostupné. Skúste stránku obnoviť.
              </p>
            </Notice>
          ) : null}
          {state.status === "READY" && state.items.length === 0 ? (
            <EmptyState
              description="Po odoslaní sa tu zobrazí stav spracovania."
              title="Zatiaľ bez žiadostí"
            />
          ) : null}
          {state.status === "READY" && state.items.length > 0 ? (
            <ol className="privacy-history__list">
              {state.items.map((item) => (
                <li key={item.caseId}>
                  <Card className="privacy-history-card">
                    <header className="privacy-history-card__header">
                      <h3>{requestTypeLabel(item.requestType)}</h3>
                      <StatusBadge tone={requestStateTone(item.state)}>
                        {requestStateLabel(item.state)}
                      </StatusBadge>
                    </header>
                    <div className="privacy-history-card__meta">
                      <p>
                        Prijaté{" "}
                        <time dateTime={item.receivedAt}>
                          {new Date(item.receivedAt).toLocaleString("sk-SK")}
                        </time>
                      </p>
                      {item.deadlineAt === null ? null : (
                        <p>
                          Očakávaný termín:{" "}
                          <time dateTime={item.deadlineAt}>
                            {new Date(item.deadlineAt).toLocaleDateString(
                              "sk-SK",
                            )}
                          </time>
                        </p>
                      )}
                    </div>
                    {privacyExportHref(item) === null ? null : (
                      <div className="privacy-history-card__export">
                        <a
                          className="ui-button ui-button--secondary"
                          download
                          href={privacyExportHref(item) ?? undefined}
                        >
                          Stiahnuť základný JSON export
                        </a>
                        <p>
                          Základný export obsahuje údaje viazané iba na vás.
                          Zdieľané obchodné záznamy a súbory doplní správca po
                          kontrole práv ostatných osôb.
                        </p>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function parsePrivacyRequests(
  value: unknown,
): readonly PrivacyRequestItem[] | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  const items: PrivacyRequestItem[] = [];
  for (const item of value.items) {
    if (
      !record(item) ||
      !exactKeys(item, [
        "actionCode",
        "caseId",
        "deadlineAt",
        "occurredAt",
        "receivedAt",
        "requestType",
        "revision",
        "state",
      ]) ||
      !uuid(item.caseId) ||
      !requestTypes.includes(item.requestType as RequestType) ||
      !requestStates.includes(item.state as RequestState) ||
      !Number.isSafeInteger(item.revision) ||
      (item.revision as number) < 1 ||
      !date(item.receivedAt) ||
      !date(item.occurredAt) ||
      !(item.deadlineAt === null || date(item.deadlineAt)) ||
      !(
        item.actionCode === null ||
        (typeof item.actionCode === "string" &&
          /^[A-Z][A-Z0-9_]{2,63}$/u.test(item.actionCode))
      )
    )
      return null;
    items.push(item as unknown as PrivacyRequestItem);
  }
  return items;
}

export function parseClosureReadiness(value: unknown): ClosureReadiness | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.canRequestClosure !== "boolean" ||
    typeof value.executionBlockedByOpenObligations !== "boolean"
  )
    return null;
  return {
    canRequestClosure: value.canRequestClosure,
    executionBlockedByOpenObligations: value.executionBlockedByOpenObligations,
  };
}

export function privacyExportHref(item: PrivacyRequestItem): string | null {
  if (
    !["ACCESS", "PORTABILITY"].includes(item.requestType) ||
    !["VERIFIED", "IN_REVIEW", "ACTION_REQUIRED", "COMPLETED"].includes(
      item.state,
    )
  )
    return null;
  return `/v1/me/privacy/requests/${item.caseId}/export`;
}

async function csrf(): Promise<string> {
  const response = await fetch("/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const body: unknown = await response.json();
  if (!response.ok || !record(body) || typeof body.csrfToken !== "string")
    throw new Error("csrf unavailable");
  return body.csrfToken;
}
function requestTypeLabel(value: RequestType): string {
  return {
    ACCESS: "Prístup k mojim údajom",
    ACCOUNT_CLOSURE: "Zatvorenie účtu",
    ERASURE: "Výmaz údajov",
    OBJECTION: "Námietka proti spracúvaniu",
    PORTABILITY: "Prenos údajov",
    RECTIFICATION: "Oprava údajov",
    RESTRICTION: "Obmedzenie spracúvania",
  }[value];
}
function requestStateLabel(value: RequestState): string {
  return {
    ACTION_REQUIRED: "Čaká na ďalší krok",
    COMPLETED: "Dokončená",
    IDENTITY_VERIFICATION_PENDING: "Čaká na overenie identity",
    IN_REVIEW: "Prebieha posúdenie",
    RECEIVED: "Prijatá",
    REJECTED: "Ukončená bez vykonania",
    VERIFIED: "Identita overená",
  }[value];
}
function requestStateTone(
  value: RequestState,
): "default" | "error" | "success" | "trust" | "warning" {
  return value === "COMPLETED"
    ? "success"
    : value === "REJECTED"
      ? "error"
      : value === "ACTION_REQUIRED"
        ? "warning"
        : value === "VERIFIED" || value === "IN_REVIEW"
          ? "trust"
          : "default";
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function date(value: unknown): value is string {
  return (
    typeof value === "string" && Number.isFinite(new Date(value).valueOf())
  );
}
