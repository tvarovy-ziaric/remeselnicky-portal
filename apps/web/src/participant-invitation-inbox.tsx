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
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export interface ParticipantInvitation {
  readonly participantId: string;
  readonly jobId: string;
  readonly providerDisplayName: string;
  readonly municipalityName: string;
  readonly primaryProfessionCode: string;
  readonly invitedAt: string;
}

export interface ParticipantInvitationPage {
  readonly items: readonly ParticipantInvitation[];
  readonly nextCursor: {
    readonly invitedAt: string;
    readonly id: string;
  } | null;
}

export type ParticipantDecision = "ACCEPT" | "DECLINE";
export type ParticipantDecisionResult =
  | { readonly status: "OK"; readonly state: "ACCEPTED" | "DECLINED" }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };

export function getParticipantDecisionCommand(
  attempts: Map<string, { decision: ParticipantDecision; commandId: string }>,
  participantId: string,
  decision: ParticipantDecision,
  generateId: () => string,
): string | null {
  const existing = attempts.get(participantId);
  if (existing)
    return existing.decision === decision ? existing.commandId : null;
  const commandId = generateId();
  if (!uuid.test(commandId)) return null;
  attempts.set(participantId, { decision, commandId });
  return commandId;
}

export function parseParticipantInvitationPage(
  value: unknown,
): ParticipantInvitationPage | null {
  if (
    !record(value) ||
    !exactKeys(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20
  )
    return null;
  const items: ParticipantInvitation[] = [];
  const ids = new Set<string>();
  for (const candidate of value.items as unknown[]) {
    if (
      !record(candidate) ||
      !exactKeys(candidate, [
        "participantId",
        "jobId",
        "providerDisplayName",
        "municipalityName",
        "primaryProfessionCode",
        "invitedAt",
      ]) ||
      typeof candidate.participantId !== "string" ||
      !uuid.test(candidate.participantId) ||
      ids.has(candidate.participantId) ||
      typeof candidate.jobId !== "string" ||
      !uuid.test(candidate.jobId) ||
      typeof candidate.providerDisplayName !== "string" ||
      candidate.providerDisplayName.trim().length < 1 ||
      candidate.providerDisplayName.length > 255 ||
      /[\r\n\p{Cc}]/u.test(candidate.providerDisplayName) ||
      typeof candidate.municipalityName !== "string" ||
      candidate.municipalityName.length < 1 ||
      candidate.municipalityName.length > 200 ||
      typeof candidate.primaryProfessionCode !== "string" ||
      !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(
        candidate.primaryProfessionCode,
      ) ||
      !isoDate(candidate.invitedAt)
    )
      return null;
    ids.add(candidate.participantId);
    items.push({
      participantId: candidate.participantId,
      jobId: candidate.jobId,
      providerDisplayName: candidate.providerDisplayName,
      municipalityName: candidate.municipalityName,
      primaryProfessionCode: candidate.primaryProfessionCode,
      invitedAt: candidate.invitedAt,
    });
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exactKeys(cursor, ["invitedAt", "id"]) ||
      !isoDate(cursor.invitedAt) ||
      typeof cursor.id !== "string" ||
      !uuid.test(cursor.id) ||
      items.length === 0 ||
      cursor.id !== items.at(-1)?.participantId ||
      cursor.invitedAt !== items.at(-1)?.invitedAt)
  )
    return null;
  return { items, nextCursor: cursor } as ParticipantInvitationPage;
}

export async function loadParticipantInvitationPage(input: {
  readonly fetch: typeof fetch;
  readonly cursor?: ParticipantInvitationPage["nextCursor"];
}): Promise<
  | { readonly status: "OK"; readonly page: ParticipantInvitationPage }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" }
> {
  const query = new URLSearchParams({ limit: "20" });
  if (input.cursor) {
    if (!isoDate(input.cursor.invitedAt) || !uuid.test(input.cursor.id))
      return { status: "UNAVAILABLE" };
    query.set("beforeAt", input.cursor.invitedAt);
    query.set("beforeId", input.cursor.id);
  }
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/invitations?${query.toString()}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseParticipantInvitationPage(await response.json());
    return page === null ? { status: "UNAVAILABLE" } : { status: "OK", page };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function sendParticipantDecision(input: {
  readonly fetch: typeof fetch;
  readonly participantId: string;
  readonly commandId: string;
  readonly decision: ParticipantDecision;
}): Promise<ParticipantDecisionResult> {
  if (
    !uuid.test(input.participantId) ||
    !uuid.test(input.commandId) ||
    (input.decision !== "ACCEPT" && input.decision !== "DECLINE")
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return { status: "AUTH_REQUIRED" };
    if (!csrfResponse.ok) return { status: "UNAVAILABLE" };
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exactKeys(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000
    )
      return { status: "UNAVAILABLE" };
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/decision`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          decision: input.decision,
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
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !exactKeys(body, ["status", "state", "recordedAt"]) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      body.state !== (input.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED") ||
      !isoDate(body.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return {
      status: "OK",
      state: input.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function ParticipantInvitationInbox() {
  const [page, setPage] = useState<ParticipantInvitationPage | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "UNAVAILABLE"
  >("LOADING");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const retry = useRef(
    new Map<string, { decision: ParticipantDecision; commandId: string }>(),
  );

  useEffect(() => {
    let active = true;
    void loadParticipantInvitationPage({ fetch: globalThis.fetch }).then(
      (result) => {
        if (!active) return;
        if (result.status === "OK") setPage(result.page);
        setStatus(result.status);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const decide = async (
    participantId: string,
    decision: ParticipantDecision,
  ) => {
    if (pendingId !== null) return;
    setPendingId(participantId);
    setError(null);
    setNotice(null);
    const commandId = getParticipantDecisionCommand(
      retry.current,
      participantId,
      decision,
      () => crypto.randomUUID(),
    );
    if (commandId === null) {
      setPendingId(null);
      setError(
        "Po neistom výsledku môžete zopakovať len pôvodné rozhodnutie. Ak ho chcete zmeniť, obnovte stránku.",
      );
      return;
    }
    const result = await sendParticipantDecision({
      fetch: globalThis.fetch,
      participantId,
      decision,
      commandId,
    });
    if (result.status === "OK") {
      retry.current.delete(participantId);
      setPage(
        (current) =>
          current && {
            ...current,
            items: current.items.filter(
              (item) => item.participantId !== participantId,
            ),
          },
      );
      setNotice(
        result.state === "ACCEPTED"
          ? "Účasť ste prijali. Až teraz je potvrdená ako vaša účasť na zákazke."
          : "Pozvanie ste odmietli. Nebude sa počítať ako účasť na zákazke.",
      );
    } else {
      setError(
        result.status === "AUTH_REQUIRED"
          ? "Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova."
          : "Výsledok rozhodnutia sa nepodarilo overiť. Skúste rovnakú akciu znova alebo obnovte stránku.",
      );
    }
    setPendingId(null);
  };

  const more = async () => {
    if (!page?.nextCursor || loadingMore || pendingId !== null) return;
    setLoadingMore(true);
    setError(null);
    const result = await loadParticipantInvitationPage({
      fetch: globalThis.fetch,
      cursor: page.nextCursor,
    });
    if (
      result.status !== "OK" ||
      result.page.items.some((item) =>
        page.items.some(
          (existing) => existing.participantId === item.participantId,
        ),
      )
    )
      setError("Ďalšie pozvania sa nepodarilo bezpečne načítať.");
    else
      setPage({
        items: [...page.items, ...result.page.items],
        nextCursor: result.page.nextCursor,
      });
    setLoadingMore(false);
  };

  if (status === "LOADING")
    return <p role="status">Načítavajú sa pozvánky na účasť…</p>;
  if (status !== "OK" || page === null)
    return (
      <p role="alert">
        {status === "AUTH_REQUIRED"
          ? "Na zobrazenie pozvánok sa prihláste."
          : "Pozvánky sa nepodarilo načítať. Skúste to znova neskôr."}
      </p>
    );
  return (
    <section aria-label="Pozvánky na účasť">
      <p>
        Pozvánka sama osebe nie je potvrdenou účasťou. Až keď ju výslovne
        prijmete, vznikne záznam o vašej účasti na zákazke.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {page.items.length === 0 && (
        <p>Zatiaľ nemáte žiadne čakajúce pozvánky na účasť.</p>
      )}
      <ul className="participant-invitation-list">
        {page.items.map((item) => (
          <li key={item.participantId}>
            <h2>Účasť na zákazke</h2>
            <p>Hlavný poskytovateľ: {item.providerDisplayName}</p>
            <p>
              Obec: {item.municipalityName} · Profesia:{" "}
              {item.primaryProfessionCode}
            </p>
            <p>
              Pozvaný/á:{" "}
              <time dateTime={item.invitedAt}>
                {new Date(item.invitedAt).toLocaleString("sk-SK")}
              </time>
            </p>
            <div className="participant-invitation-actions">
              <button
                disabled={
                  pendingId !== null ||
                  (retry.current.get(item.participantId) !== undefined &&
                    retry.current.get(item.participantId)?.decision !==
                      "ACCEPT")
                }
                onClick={() => void decide(item.participantId, "ACCEPT")}
                type="button"
              >
                {pendingId === item.participantId
                  ? "Ukladám rozhodnutie…"
                  : "Prijať účasť"}
              </button>
              <button
                disabled={
                  pendingId !== null ||
                  (retry.current.get(item.participantId) !== undefined &&
                    retry.current.get(item.participantId)?.decision !==
                      "DECLINE")
                }
                onClick={() => void decide(item.participantId, "DECLINE")}
                type="button"
              >
                Odmietnuť
              </button>
            </div>
          </li>
        ))}
      </ul>
      {page.nextCursor && (
        <button
          disabled={loadingMore || pendingId !== null}
          onClick={() => void more()}
          type="button"
        >
          {loadingMore ? "Načítavam…" : "Načítať ďalšie pozvánky"}
        </button>
      )}
    </section>
  );
}
