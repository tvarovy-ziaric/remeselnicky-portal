"use client";

import React, { useRef, useState } from "react";

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

export type ProviderParticipantInviteResult =
  | { readonly status: "SENT"; readonly participantId: string }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };

export async function sendProviderParticipantInvitation(input: {
  readonly jobId: string;
  readonly craftsmanProfileId: string;
  readonly profileType: "INDIVIDUAL" | "COMPANY";
  readonly commandId: string;
  readonly fetch: typeof fetch;
}): Promise<ProviderParticipantInviteResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.craftsmanProfileId) ||
    !uuid.test(input.commandId) ||
    input.profileType !== "INDIVIDUAL"
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
      `/v1/me/jobs/${input.jobId}/participants`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          craftsmanProfileId: input.craftsmanProfileId,
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
      !exactKeys(body, ["status", "participantId", "invitedAt"]) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      typeof body.participantId !== "string" ||
      !uuid.test(body.participantId) ||
      !isoDate(body.invitedAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "SENT", participantId: body.participantId };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function ProviderParticipantInvitationButton({
  jobId,
  craftsmanProfileId,
  profileType,
}: {
  readonly jobId: string;
  readonly craftsmanProfileId: string;
  readonly profileType: "INDIVIDUAL" | "COMPANY";
}) {
  const [status, setStatus] = useState<
    "IDLE" | "PENDING" | "SENT" | "AUTH_REQUIRED" | "UNAVAILABLE"
  >("IDLE");
  const retryCommandId = useRef<string | null>(null);
  if (profileType !== "INDIVIDUAL") return null;
  const send = async () => {
    if (status === "PENDING" || status === "SENT") return;
    setStatus("PENDING");
    retryCommandId.current ??= crypto.randomUUID();
    const result = await sendProviderParticipantInvitation({
      jobId,
      craftsmanProfileId,
      profileType,
      commandId: retryCommandId.current,
      fetch: globalThis.fetch,
    });
    if (result.status === "SENT") retryCommandId.current = null;
    setStatus(result.status);
  };
  return (
    <div className="participant-invitation-action">
      <button
        disabled={status === "PENDING" || status === "SENT"}
        onClick={() => void send()}
        type="button"
      >
        {status === "PENDING"
          ? "Posielam pozvanie…"
          : status === "SENT"
            ? "Pozvanie odoslané"
            : "Pozvať na zákazku"}
      </button>
      {status === "SENT" && (
        <p role="status">
          Pozvanie čaká na prijatie. Overená účasť vznikne až po výslovnom
          potvrdení pozvaným remeselníkom.
        </p>
      )}
      {status === "AUTH_REQUIRED" && (
        <p role="alert">
          Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova.
        </p>
      )}
      {status === "UNAVAILABLE" && (
        <p role="alert">
          Výsledok pozvania sa nepodarilo overiť. Skúste to znova alebo obnovte
          stránku.
        </p>
      )}
    </div>
  );
}
