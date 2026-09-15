"use client";

import React, { useState } from "react";

export type CustomerInvitationSendStatus =
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "SENT"
  | "TARGET_UNAVAILABLE"
  | "UNAVAILABLE"
  | "VERIFICATION_REQUIRED";

export function CustomerInvitationButton({
  craftsmanProfileId,
  jobRequestId,
}: {
  readonly craftsmanProfileId: string;
  readonly jobRequestId: string;
}) {
  const [status, setStatus] = useState<
    CustomerInvitationSendStatus | "IDLE" | "SENDING"
  >("IDLE");
  const disabled = status === "SENDING" || status === "SENT";
  return (
    <div>
      <button
        disabled={disabled}
        onClick={() => {
          setStatus("SENDING");
          void sendCustomerInvitation({
            craftsmanProfileId,
            jobRequestId,
          }).then(setStatus);
        }}
        type="button"
      >
        {status === "SENDING"
          ? "Posielam pozvanie…"
          : status === "SENT"
            ? "Pozvanie odoslané"
            : "Pozvať k zákazke"}
      </button>
      {status === "AUTH_REQUIRED" ? (
        <p aria-live="polite">Na odoslanie pozvania sa prihláste.</p>
      ) : status === "VERIFICATION_REQUIRED" ? (
        <p aria-live="polite">
          Pred pozvaním si overte e-mail aj telefónne číslo.
        </p>
      ) : status === "LIMIT_REACHED" ? (
        <p aria-live="polite">
          Táto zákazka už má päť aktívnych pozvaní. Najprv jedno uzavrite.
        </p>
      ) : status === "TARGET_UNAVAILABLE" ? (
        <p aria-live="polite">Tohto remeselníka už nemožno pozvať.</p>
      ) : status === "UNAVAILABLE" ? (
        <p aria-live="polite">
          Pozvanie sa teraz nepodarilo odoslať. Skúste to znova.
        </p>
      ) : null}
    </div>
  );
}

export async function sendCustomerInvitation(input: {
  readonly commandId?: () => string;
  readonly craftsmanProfileId: string;
  readonly fetch?: typeof fetch;
  readonly jobRequestId: string;
}): Promise<CustomerInvitationSendStatus> {
  if (!uuid(input.craftsmanProfileId) || !uuid(input.jobRequestId)) {
    return "UNAVAILABLE";
  }
  const fetcher = input.fetch ?? fetch;
  const commandId = input.commandId?.() ?? crypto.randomUUID();
  if (!uuid(commandId)) return "UNAVAILABLE";
  const requestOptions: RequestInit = {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  };
  try {
    const session = await fetcher("/v1/auth/session", requestOptions);
    if (session.status === 401) return "AUTH_REQUIRED";
    if (!session.ok) return "UNAVAILABLE";
    const sessionBody: unknown = await session.json();
    if (!record(sessionBody) || typeof sessionBody["csrfToken"] !== "string") {
      return "UNAVAILABLE";
    }
    const response = await fetcher(
      `/v1/me/job-requests/${encodeURIComponent(input.jobRequestId)}/invitations`,
      {
        body: JSON.stringify({
          commandId,
          craftsmanProfileId: input.craftsmanProfileId,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": sessionBody["csrfToken"],
        },
        method: "POST",
      },
    );
    if (response.status === 401) return "AUTH_REQUIRED";
    if (response.status === 403) return "VERIFICATION_REQUIRED";
    if (response.status === 404) return "TARGET_UNAVAILABLE";
    const body: unknown = await response.json();
    if (response.status === 409) {
      return record(body) && body["code"] === "ACTIVE_LIMIT_REACHED"
        ? "LIMIT_REACHED"
        : "UNAVAILABLE";
    }
    return response.ok && record(body) && successful(body["status"])
      ? "SENT"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function successful(value: unknown): boolean {
  return ["ALREADY_INVITED", "APPLIED", "DEDUPLICATED"].includes(String(value));
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
