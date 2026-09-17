"use client";

import React, { useEffect, useRef, useState } from "react";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const isoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

type Role = "LEAD" | "COORDINATOR" | "SITE_MANAGER";
type Decision = "CONFIRM" | "REQUEST_CORRECTION";
export interface PendingRoleAssignment {
  readonly assignmentEventId: string;
  readonly participantId: string;
  readonly role: Role;
  readonly assignedAt: string;
}
export interface PendingRoleAssignments {
  readonly items: readonly PendingRoleAssignment[];
}
type LoadResult =
  | { readonly status: "OK"; readonly page: PendingRoleAssignments }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

export function parsePendingRoleAssignments(
  value: unknown,
  participantId: string,
): PendingRoleAssignments | null {
  if (
    !uuid.test(participantId) ||
    !record(value) ||
    !exact(value, ["items"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 3
  )
    return null;
  const items: PendingRoleAssignment[] = [];
  const roles = new Set<Role>();
  for (const entry of value.items as unknown[]) {
    if (
      !record(entry) ||
      !exact(entry, [
        "assignmentEventId",
        "participantId",
        "role",
        "assignedAt",
      ]) ||
      typeof entry.assignmentEventId !== "string" ||
      !uuid.test(entry.assignmentEventId) ||
      entry.participantId !== participantId ||
      !["LEAD", "COORDINATOR", "SITE_MANAGER"].includes(String(entry.role)) ||
      !isoDate(entry.assignedAt)
    )
      return null;
    const role = entry.role as Role;
    if (roles.has(role)) return null;
    roles.add(role);
    items.push(entry as unknown as PendingRoleAssignment);
  }
  return { items };
}

export async function loadPendingRoleAssignments(input: {
  readonly fetch: typeof fetch;
  readonly participantId: string;
}): Promise<LoadResult> {
  if (!uuid.test(input.participantId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/role-assignments`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parsePendingRoleAssignments(
      await response.json(),
      input.participantId,
    );
    return page === null ? { status: "UNAVAILABLE" } : { status: "OK", page };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

type Attempt = Readonly<{
  decision: Decision;
  reason: string | null;
  commandId: string;
}>;
export function getRoleDecisionCommandId(
  attempts: Map<string, Attempt>,
  assignmentEventId: string,
  decision: Decision,
  reason: string | null,
  nextId: () => string,
): string | null {
  if (!uuid.test(assignmentEventId)) return null;
  const existing = attempts.get(assignmentEventId);
  if (existing) {
    return existing.decision === decision && existing.reason === reason
      ? existing.commandId
      : null;
  }
  const commandId = nextId();
  if (!uuid.test(commandId)) return null;
  attempts.set(assignmentEventId, { decision, reason, commandId });
  return commandId;
}

export async function sendRoleDecision(input: {
  readonly fetch: typeof fetch;
  readonly participantId: string;
  readonly assignmentEventId: string;
  readonly commandId: string;
  readonly decision: Decision;
  readonly reason: string | null;
}): Promise<"OK" | "AUTH_REQUIRED" | "UNAVAILABLE"> {
  if (
    ![input.participantId, input.assignmentEventId, input.commandId].every(
      (id) => uuid.test(id),
    ) ||
    (input.decision === "CONFIRM" && input.reason !== null) ||
    (input.decision === "REQUEST_CORRECTION" &&
      (input.reason === null ||
        input.reason !== input.reason.trim() ||
        input.reason.length < 8 ||
        input.reason.length > 500 ||
        /[\p{Cc}]/u.test(input.reason)))
  )
    return "UNAVAILABLE";
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return "AUTH_REQUIRED";
    if (!csrfResponse.ok) return "UNAVAILABLE";
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exact(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1000
    )
      return "UNAVAILABLE";
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/role-assignments/${input.assignmentEventId}/decision`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          decision: input.decision,
          ...(input.reason === null ? {} : { reason: input.reason }),
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return "AUTH_REQUIRED";
    if (!response.ok) return "UNAVAILABLE";
    const body: unknown = await response.json();
    return record(body) &&
      exact(body, ["status", "decisionId", "decision", "decidedAt"]) &&
      (body.status === "APPLIED" || body.status === "DEDUPLICATED") &&
      body.decisionId === input.commandId &&
      body.decision === input.decision &&
      isoDate(body.decidedAt)
      ? "OK"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

const roleLabels: Record<Role, string> = {
  LEAD: "Vedúci",
  COORDINATOR: "Koordinátor",
  SITE_MANAGER: "Stavbyvedúci",
};

export function ParticipantRoleDecisions({
  participantId,
}: {
  readonly participantId: string;
}) {
  const [page, setPage] = useState<PendingRoleAssignments | null>(null);
  const [status, setStatus] = useState<LoadResult["status"] | "LOADING">(
    "LOADING",
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(new Map<string, Attempt>());
  useEffect(() => {
    let active = true;
    void loadPendingRoleAssignments({
      fetch: globalThis.fetch,
      participantId,
    }).then((result) => {
      if (!active) return;
      setStatus(result.status);
      setPage(result.status === "OK" ? result.page : null);
    });
    return () => {
      active = false;
    };
  }, [participantId]);

  const decide = async (assignmentEventId: string, decision: Decision) => {
    if (busyId !== null) return;
    const reason =
      decision === "REQUEST_CORRECTION"
        ? (reasonById[assignmentEventId] ?? "").trim()
        : null;
    if (decision === "REQUEST_CORRECTION" && (!reason || reason.length < 8)) {
      setError("Pri žiadosti o opravu stručne opíšte, čo nesedí.");
      return;
    }
    const commandId = getRoleDecisionCommandId(
      attempts.current,
      assignmentEventId,
      decision,
      reason,
      () => crypto.randomUUID(),
    );
    if (commandId === null) {
      setError("Po neistom výsledku zopakujte pôvodné rozhodnutie.");
      return;
    }
    setBusyId(assignmentEventId);
    setError(null);
    const result = await sendRoleDecision({
      fetch: globalThis.fetch,
      participantId,
      assignmentEventId,
      commandId,
      decision,
      reason,
    });
    if (result === "OK") {
      const refreshed = await loadPendingRoleAssignments({
        fetch: globalThis.fetch,
        participantId,
      });
      if (refreshed.status === "OK") {
        setPage(refreshed.page);
        setStatus("OK");
        if (
          !refreshed.page.items.some(
            (item) => item.assignmentEventId === assignmentEventId,
          )
        )
          attempts.current.delete(assignmentEventId);
        setNotice(
          decision === "CONFIRM"
            ? "Rolu ste potvrdili. Overenou pracovnou históriou sa stane až po dokončení zákazky."
            : "Žiadosť o opravu bola zaznamenaná; táto rola nie je overená.",
        );
      } else {
        setError("Výsledok sa nepodarilo overiť. Skúste tú istú akciu znova.");
      }
    } else {
      setError("Rozhodnutie sa nepodarilo overiť. Skúste tú istú akciu znova.");
    }
    setBusyId(null);
  };

  if (status === "NOT_FOUND" || status === "AUTH_REQUIRED") return null;
  return (
    <section aria-label="Potvrdenie rolí na zákazke">
      <h3>Roly na zákazke</h3>
      <p>
        Pridelená rola nie je overenou pracovnou históriou, kým ju nepotvrdíte a
        zákazka sa nedokončí.
      </p>
      {status === "LOADING" && <p role="status">Načítavam roly…</p>}
      {status === "UNAVAILABLE" && (
        <p role="alert">Roly sa teraz nepodarilo načítať.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {page?.items.length === 0 && (
        <p>Nemáte žiadne roly čakajúce na rozhodnutie.</p>
      )}
      {page && page.items.length > 0 && (
        <ul className="participant-invitation-list">
          {page.items.map((item) => (
            <li key={item.assignmentEventId}>
              <strong>{roleLabels[item.role]}</strong>
              <p>
                Pridelené:{" "}
                <time dateTime={item.assignedAt}>
                  {new Date(item.assignedAt).toLocaleString("sk-SK")}
                </time>
              </p>
              <button
                disabled={busyId !== null}
                onClick={() => void decide(item.assignmentEventId, "CONFIRM")}
                type="button"
              >
                Potvrdiť rolu
              </button>
              <label>
                Čo treba opraviť?
                <textarea
                  maxLength={500}
                  minLength={8}
                  onChange={(event) =>
                    setReasonById((current) => ({
                      ...current,
                      [item.assignmentEventId]: event.target.value,
                    }))
                  }
                  value={reasonById[item.assignmentEventId] ?? ""}
                />
              </label>
              <button
                disabled={busyId !== null}
                onClick={() =>
                  void decide(item.assignmentEventId, "REQUEST_CORRECTION")
                }
                type="button"
              >
                Požiadať o opravu
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
