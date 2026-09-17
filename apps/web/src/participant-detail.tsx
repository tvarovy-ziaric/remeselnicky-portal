"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  getParticipantDecisionCommand,
  sendParticipantDecision,
  type ParticipantDecision,
} from "./participant-invitation-inbox";
import { leaveParticipation } from "./participant-history";

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

export interface JobParticipantDetail {
  readonly participantId: string;
  readonly jobId: string;
  readonly viewerRole: "PARTICIPANT" | "PRIMARY_PROVIDER" | "CUSTOMER";
  readonly state: "INVITED" | "ACCEPTED" | "DECLINED" | "LEFT" | "REMOVED";
  readonly jobState:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  readonly participantDisplayName: string;
  readonly providerDisplayName: string;
  readonly municipalityName: string;
  readonly primaryProfessionCode: string;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly leftAt: string | null;
  readonly canDecide: boolean;
  readonly canLeave: boolean;
}

export function parseJobParticipantDetail(
  value: unknown,
): JobParticipantDetail | null {
  if (
    !record(value) ||
    !exact(value, [
      "participantId",
      "jobId",
      "viewerRole",
      "state",
      "jobState",
      "participantDisplayName",
      "providerDisplayName",
      "municipalityName",
      "primaryProfessionCode",
      "invitedAt",
      "acceptedAt",
      "leftAt",
      "canDecide",
      "canLeave",
    ]) ||
    typeof value.participantId !== "string" ||
    !uuid.test(value.participantId) ||
    typeof value.jobId !== "string" ||
    !uuid.test(value.jobId) ||
    !["PARTICIPANT", "PRIMARY_PROVIDER", "CUSTOMER"].includes(
      String(value.viewerRole),
    ) ||
    !["INVITED", "ACCEPTED", "DECLINED", "LEFT", "REMOVED"].includes(
      String(value.state),
    ) ||
    ![
      "CONFIRMED",
      "IN_PROGRESS",
      "COMPLETION_REQUESTED",
      "COMPLETED",
      "CANCELLED",
    ].includes(String(value.jobState)) ||
    typeof value.participantDisplayName !== "string" ||
    value.participantDisplayName.trim().length < 1 ||
    value.participantDisplayName.length > 255 ||
    typeof value.providerDisplayName !== "string" ||
    value.providerDisplayName.trim().length < 1 ||
    value.providerDisplayName.length > 255 ||
    /[\p{Cc}]/u.test(value.participantDisplayName) ||
    /[\p{Cc}]/u.test(value.providerDisplayName) ||
    typeof value.municipalityName !== "string" ||
    value.municipalityName.trim().length < 1 ||
    value.municipalityName.length > 200 ||
    typeof value.primaryProfessionCode !== "string" ||
    !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(
      value.primaryProfessionCode,
    ) ||
    !isoDate(value.invitedAt) ||
    (value.acceptedAt !== null && !isoDate(value.acceptedAt)) ||
    (value.leftAt !== null && !isoDate(value.leftAt)) ||
    typeof value.canDecide !== "boolean" ||
    typeof value.canLeave !== "boolean" ||
    (value.state === "INVITED" || value.state === "DECLINED") !==
      (value.acceptedAt === null) ||
    (value.state === "LEFT" || value.state === "REMOVED") !==
      (value.leftAt !== null) ||
    (value.viewerRole === "CUSTOMER" && value.acceptedAt === null) ||
    (value.canDecide &&
      (value.viewerRole !== "PARTICIPANT" ||
        value.state !== "INVITED" ||
        value.jobState === "CANCELLED")) ||
    (value.canLeave &&
      (value.viewerRole !== "PARTICIPANT" ||
        value.state !== "ACCEPTED" ||
        value.jobState === "CANCELLED"))
  )
    return null;
  return value as unknown as JobParticipantDetail;
}

export async function loadJobParticipantDetail(input: {
  readonly fetch: typeof fetch;
  readonly participantId: string;
}): Promise<
  | { readonly status: "OK"; readonly detail: JobParticipantDetail }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" | "NOT_FOUND" }
> {
  if (!uuid.test(input.participantId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const detail = parseJobParticipantDetail(await response.json());
    return detail === null
      ? { status: "UNAVAILABLE" }
      : { status: "OK", detail };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

const stateLabels: Record<JobParticipantDetail["state"], string> = {
  INVITED: "Čaká na vaše rozhodnutie",
  ACCEPTED: "Potvrdená účasť",
  DECLINED: "Odmietnuté pozvanie",
  LEFT: "Účasť ste ukončili",
  REMOVED: "Účasť ukončil hlavný poskytovateľ",
};

export function ParticipantDetail({
  participantId,
  context,
  jobId,
}: {
  readonly participantId: string;
  readonly context: "INVITATION" | "HISTORY" | "JOB_PARTY";
  readonly jobId?: string;
}) {
  const [detail, setDetail] = useState<JobParticipantDetail | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "UNAVAILABLE" | "NOT_FOUND"
  >("LOADING");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decisionAttempts = useRef(
    new Map<string, { decision: ParticipantDecision; commandId: string }>(),
  );
  const leaveAttempt = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadJobParticipantDetail({
      fetch: globalThis.fetch,
      participantId,
    }).then((result) => {
      if (!active) return;
      if (result.status !== "OK") {
        setStatus(result.status);
        return;
      }
      if (
        (context === "JOB_PARTY" && result.detail.jobId !== jobId) ||
        (context !== "JOB_PARTY" &&
          result.detail.viewerRole !== "PARTICIPANT") ||
        (context === "INVITATION" && result.detail.state !== "INVITED") ||
        (context === "HISTORY" && result.detail.state === "INVITED")
      ) {
        setStatus("NOT_FOUND");
        return;
      }
      setDetail(result.detail);
      setStatus("OK");
    });
    return () => {
      active = false;
    };
  }, [participantId, context, jobId]);

  const refresh = async () => {
    const result = await loadJobParticipantDetail({
      fetch: globalThis.fetch,
      participantId,
    });
    if (result.status !== "OK") {
      setDetail(null);
      setStatus(result.status);
      return false;
    }
    setDetail(result.detail);
    return true;
  };

  const decide = async (decision: ParticipantDecision) => {
    if (busy || detail?.canDecide !== true) return;
    setBusy(true);
    setError(null);
    const commandId = getParticipantDecisionCommand(
      decisionAttempts.current,
      participantId,
      decision,
      () => crypto.randomUUID(),
    );
    if (commandId === null) {
      setError("Po neistom výsledku môžete zopakovať len pôvodné rozhodnutie.");
      setBusy(false);
      return;
    }
    const result = await sendParticipantDecision({
      fetch: globalThis.fetch,
      participantId,
      commandId,
      decision,
    });
    if (result.status === "OK" && (await refresh())) {
      decisionAttempts.current.delete(participantId);
      setNotice(
        decision === "ACCEPT"
          ? "Účasť ste potvrdili. Záznam zostane v histórii."
          : "Pozvanie ste odmietli; nevznikla potvrdená účasť.",
      );
    } else if (result.status !== "OK") {
      setError("Výsledok sa nepodarilo overiť. Skúste rovnakú akciu znova.");
    }
    setBusy(false);
  };

  const leave = async () => {
    if (busy || detail?.canLeave !== true) return;
    setBusy(true);
    setError(null);
    const commandId = leaveAttempt.current ?? crypto.randomUUID();
    leaveAttempt.current = commandId;
    const result = await leaveParticipation({
      fetch: globalThis.fetch,
      participantId,
      commandId,
    });
    if (result === "OK" && (await refresh())) {
      leaveAttempt.current = null;
      setNotice("Vaša účasť sa ukončila; história zostáva zachovaná.");
    } else if (result !== "OK") {
      setError("Výsledok sa nepodarilo overiť. Skúste ukončenie zopakovať.");
    }
    setBusy(false);
  };

  if (status === "LOADING") return <p role="status">Načítavam účasť…</p>;
  if (status === "AUTH_REQUIRED")
    return (
      <p role="alert">
        Na zobrazenie účasti sa prihláste.{" "}
        <a href="/prihlasenie">Prihlásiť sa</a>
      </p>
    );
  if (status !== "OK" || detail === null)
    return (
      <p role="alert">
        {status === "NOT_FOUND"
          ? "Táto účasť nie je dostupná."
          : "Účasť sa teraz nepodarilo bezpečne načítať."}
      </p>
    );
  return (
    <section aria-label="Detail účasti">
      <h2>{stateLabels[detail.state]}</h2>
      <p>Účastník: {detail.participantDisplayName}</p>
      <p>Hlavný poskytovateľ: {detail.providerDisplayName}</p>
      <p>
        Obec: {detail.municipalityName} · Profesia zákazky:{" "}
        {detail.primaryProfessionCode}
      </p>
      <p>
        Pozvanie:{" "}
        <time dateTime={detail.invitedAt}>
          {new Date(detail.invitedAt).toLocaleString("sk-SK")}
        </time>
      </p>
      {detail.acceptedAt && (
        <p>
          Prijaté:{" "}
          <time dateTime={detail.acceptedAt}>
            {new Date(detail.acceptedAt).toLocaleString("sk-SK")}
          </time>
        </p>
      )}
      {detail.leftAt && (
        <p>
          Ukončené:{" "}
          <time dateTime={detail.leftAt}>
            {new Date(detail.leftAt).toLocaleString("sk-SK")}
          </time>
        </p>
      )}
      {detail.jobState === "CANCELLED" && <p>Zákazka bola zrušená.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {context === "INVITATION" && detail.canDecide && (
        <div className="participant-invitation-actions">
          <button
            disabled={busy}
            onClick={() => void decide("ACCEPT")}
            type="button"
          >
            Prijať účasť
          </button>
          <button
            disabled={busy}
            onClick={() => void decide("DECLINE")}
            type="button"
          >
            Odmietnuť
          </button>
        </div>
      )}
      {context === "HISTORY" && detail.canLeave && (
        <button disabled={busy} onClick={() => void leave()} type="button">
          Ukončiť moju účasť
        </button>
      )}
      {context === "JOB_PARTY" && (
        <p>
          <a href={`/zakazky/${detail.jobId}`}>Späť na zákazku</a>
        </p>
      )}
      {context === "INVITATION" && detail.state !== "INVITED" && (
        <p>
          <a href={`/ucasti/historia/${detail.participantId}`}>
            Zobraziť záznam v histórii účasti
          </a>
        </p>
      )}
    </section>
  );
}
