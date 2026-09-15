"use client";

import React, { useEffect, useState } from "react";

interface InvitationListView {
  readonly changedAt: string;
  readonly counterpartDisplayName: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly perspective: "CRAFTSMAN" | "CUSTOMER";
  readonly requestTitle: string;
  readonly revision: number;
  readonly state: string;
}

type InboxResult =
  | { readonly items: readonly InvitationListView[]; readonly status: "OK" }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };

export function JobInvitationInbox() {
  const [result, setResult] = useState<InboxResult | null>(null);
  useEffect(() => {
    let active = true;
    void loadJobInvitationInbox().then((loaded) => {
      if (active) setResult(loaded);
    });
    return () => {
      active = false;
    };
  }, []);
  if (result === null) return <p aria-live="polite">Načítavam pozvania…</p>;
  if (!("items" in result)) {
    return (
      <p aria-live="polite">
        {result.status === "AUTH_REQUIRED"
          ? "Na zobrazenie pozvaní sa prihláste."
          : "Pozvania sa teraz nepodarilo načítať."}
      </p>
    );
  }
  if (result.items.length === 0) {
    return <p aria-live="polite">Zatiaľ nemáte žiadne pozvania.</p>;
  }
  return (
    <ul className="invitation-inbox">
      {result.items.map((item) => (
        <li key={item.id}>
          <a href={`/invitations/${encodeURIComponent(item.id)}`}>
            <strong>{item.requestTitle}</strong>
            <span>{item.counterpartDisplayName}</span>
            <span>{invitationStateLabel(item.state)}</span>
            <small>
              Posledná aktivita:{" "}
              {new Date(item.changedAt).toLocaleDateString("sk-SK")}
            </small>
          </a>
        </li>
      ))}
    </ul>
  );
}

export async function loadJobInvitationInbox(
  input: {
    readonly fetch?: typeof fetch;
  } = {},
): Promise<InboxResult> {
  try {
    const response = await (input.fetch ?? fetch)(
      "/v1/me/invitations?limit=100",
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(body["items"]) ||
      body["items"].length > 100
    ) {
      return { status: "UNAVAILABLE" };
    }
    const items: InvitationListView[] = [];
    for (const value of body["items"]) {
      const item = parseItem(value);
      if (item === null) return { status: "UNAVAILABLE" };
      items.push(item);
    }
    return { items: Object.freeze(items), status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function parseItem(value: unknown): InvitationListView | null {
  if (!record(value)) return null;
  const keys = [
    "changedAt",
    "counterpartDisplayName",
    "expiresAt",
    "id",
    "jobRequestId",
    "perspective",
    "requestTitle",
    "revision",
    "state",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    return null;
  if (
    !uuid(value["id"]) ||
    !uuid(value["jobRequestId"]) ||
    (value["perspective"] !== "CRAFTSMAN" &&
      value["perspective"] !== "CUSTOMER") ||
    typeof value["counterpartDisplayName"] !== "string" ||
    value["counterpartDisplayName"].length > 200 ||
    typeof value["requestTitle"] !== "string" ||
    value["requestTitle"].length > 200 ||
    typeof value["changedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["changedAt"])) ||
    typeof value["expiresAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["expiresAt"])) ||
    !Number.isSafeInteger(value["revision"]) ||
    (value["revision"] as number) < 1 ||
    ![
      "PENDING",
      "ENGAGED",
      "DECLINED",
      "EXPIRED",
      "WITHDRAWN",
      "NOT_SELECTED",
    ].includes(String(value["state"]))
  )
    return null;
  return {
    changedAt: value["changedAt"],
    counterpartDisplayName: value["counterpartDisplayName"],
    expiresAt: value["expiresAt"],
    id: value["id"],
    perspective: value["perspective"],
    requestTitle: value["requestTitle"],
    revision: value["revision"] as number,
    state: value["state"] as string,
  };
}

function invitationStateLabel(state: string): string {
  return (
    (
      {
        DECLINED: "Odmietnuté",
        ENGAGED: "Záujem potvrdený",
        EXPIRED: "Platnosť vypršala",
        NOT_SELECTED: "Ďalej sa neposudzuje",
        PENDING: "Čaká na rozhodnutie",
        WITHDRAWN: "Stiahnuté",
      } as Record<string, string>
    )[state] ?? "Neznámy stav"
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
