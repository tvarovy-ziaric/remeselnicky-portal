"use client";

import { useCallback, useEffect, useState } from "react";

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

  return (
    <section aria-labelledby="privacy-title" className="privacy-center">
      <p className="eyebrow">Účet</p>
      <h1 id="privacy-title">Súkromie a moje údaje</h1>
      <p>
        Požiadajte o prístup, opravu, výmaz, obmedzenie, prenos údajov,
        namietanie alebo zatvorenie účtu. Žiadosti preveruje oprávnený správca;
        samotné odoslanie nič automaticky nemaže.
      </p>

      <div className="privacy-request-form">
        <label htmlFor="privacy-request-type">Typ žiadosti</label>
        <select
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
        </select>
        {requestType === "ACCOUNT_CLOSURE" ? (
          <div className="privacy-warning">
            <strong>Zatvorenie účtu je kontrolovaný proces.</strong>
            <span>
              Verejné zobrazenie a prístup sa po overení deaktivujú ako prvé.
              Zdieľaná obchodná história sa nemaže kaskádovo; každá kategória
              údajov sa posúdi na výmaz, anonymizáciu alebo odôvodnené
              uchovanie.
            </span>
            {state.status === "READY" &&
            state.readiness.executionBlockedByOpenObligations ? (
              <span role="status">
                Vykonanie je momentálne blokované aktívnou zákazkou alebo
                otvoreným sporom. Žiadosť môžete odoslať už teraz.
              </span>
            ) : null}
          </div>
        ) : null}
        <button
          disabled={submitting || state.status === "LOADING"}
          type="button"
          onClick={() => void submitRequest()}
        >
          {submitting ? "Odosielam…" : "Odoslať žiadosť"}
        </button>
      </div>

      {notice ? <p role="status">{notice}</p> : null}
      {state.status === "LOADING" ? (
        <p aria-live="polite">Načítavam žiadosti…</p>
      ) : null}
      {state.status === "ERROR" ? (
        <p aria-live="polite">Súkromné žiadosti teraz nie sú dostupné.</p>
      ) : null}
      {state.status === "READY" ? (
        <section
          className="privacy-request-history"
          aria-labelledby="history-title"
        >
          <h2 id="history-title">Moje žiadosti</h2>
          {state.items.length === 0 ? (
            <p>Zatiaľ nemáte žiadnu žiadosť.</p>
          ) : (
            <ol>
              {state.items.map((item) => (
                <li key={item.caseId}>
                  <strong>{requestTypeLabel(item.requestType)}</strong>
                  <span>{requestStateLabel(item.state)}</span>
                  <small>
                    Prijaté{" "}
                    <time dateTime={item.receivedAt}>
                      {new Date(item.receivedAt).toLocaleString("sk-SK")}
                    </time>
                  </small>
                  {item.deadlineAt === null ? null : (
                    <small>
                      Termín:{" "}
                      {new Date(item.deadlineAt).toLocaleDateString("sk-SK")}
                    </small>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </section>
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
