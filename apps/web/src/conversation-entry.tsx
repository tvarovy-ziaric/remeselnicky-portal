"use client";

import React, { useEffect, useState } from "react";

export interface ConversationView {
  readonly access: "READ_ONLY" | "WRITABLE";
  readonly counterpartDisplayName: string;
  readonly createdAt: string;
  readonly id: string;
  readonly invitationId: string;
  readonly jobRequestId: string;
  readonly participantRole: "CRAFTSMAN" | "CUSTOMER";
  readonly requestTitle: string;
}

export type ConversationLoadResult =
  | {
      readonly status:
        "ACCOUNT_INACTIVE" | "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE";
    }
  | { readonly conversation: ConversationView; readonly status: "OK" };

export function ConversationEntry({
  invitationId,
}: {
  readonly invitationId: string;
}) {
  const [result, setResult] = useState<ConversationLoadResult | null>(null);
  useEffect(() => {
    let active = true;
    void loadConversationByInvitation({ invitationId }).then((loaded) => {
      if (active) setResult(loaded);
    });
    return () => {
      active = false;
    };
  }, [invitationId]);

  if (result === null) return <p aria-live="polite">Načítavam konverzáciu…</p>;
  if (result.status !== "OK")
    return <ConversationFailure status={result.status} />;
  const conversation = result.conversation;
  return (
    <article className="invitation-detail">
      <header>
        <p className="eyebrow">Súkromná konverzácia</p>
        <h1>{conversation.requestTitle}</h1>
        <p>S účastníkom: {conversation.counterpartDisplayName}</p>
      </header>
      {conversation.access === "WRITABLE" ? (
        <p aria-live="polite">
          Konverzácia je otvorená. Správy v nej uvidia iba účastníci tohto
          konkrétneho pozvania.
        </p>
      ) : (
        <p aria-live="polite">
          Konverzácia je iba na čítanie. Jej obchodná história zostáva
          zachovaná.
        </p>
      )}
      <p className="privacy-note">
        Pred potvrdením zákazky nezdieľajte telefón, e-mail ani presnú adresu.
      </p>
      <a href={`/invitations/${encodeURIComponent(conversation.invitationId)}`}>
        Späť na pozvanie
      </a>
    </article>
  );
}

export async function loadConversationByInvitation(input: {
  readonly fetch?: typeof fetch;
  readonly invitationId: string;
}): Promise<ConversationLoadResult> {
  if (!uuid(input.invitationId)) return { status: "NOT_FOUND" };
  try {
    const response = await (input.fetch ?? fetch)(
      `/v1/me/invitations/${encodeURIComponent(input.invitationId)}/conversation`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "ACCOUNT_INACTIVE" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const conversation = parseConversation(await response.json());
    return conversation === null
      ? { status: "UNAVAILABLE" }
      : { conversation, status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function parseConversation(value: unknown): ConversationView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "access",
      "counterpartDisplayName",
      "createdAt",
      "id",
      "invitationId",
      "jobRequestId",
      "participantRole",
      "requestTitle",
    ]) ||
    (value["access"] !== "READ_ONLY" && value["access"] !== "WRITABLE") ||
    (value["participantRole"] !== "CUSTOMER" &&
      value["participantRole"] !== "CRAFTSMAN") ||
    !uuid(value["id"]) ||
    !uuid(value["invitationId"]) ||
    !uuid(value["jobRequestId"]) ||
    !boundedText(value["counterpartDisplayName"], 200) ||
    !boundedText(value["requestTitle"], 160) ||
    !validDate(value["createdAt"])
  ) {
    return null;
  }
  return value as unknown as ConversationView;
}

function ConversationFailure({
  status,
}: {
  readonly status: Exclude<ConversationLoadResult["status"], "OK">;
}) {
  const text =
    status === "AUTH_REQUIRED"
      ? "Na zobrazenie konverzácie sa prihláste."
      : status === "ACCOUNT_INACTIVE"
        ? "Účet momentálne nemôže pracovať s konverzáciami."
        : status === "NOT_FOUND"
          ? "Konverzácia nie je dostupná."
          : "Konverzáciu sa teraz nepodarilo načítať.";
  return <p aria-live="polite">{text}</p>;
}

function exactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
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
