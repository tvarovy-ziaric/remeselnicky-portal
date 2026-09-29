"use client";

import React, { useEffect, useState } from "react";

import { ActionLink, Card, EmptyState, StatusBadge } from "./design-system";

export interface InvitationListView {
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
    return <JobInvitationInboxView items={[]} />;
  }
  return <JobInvitationInboxView items={result.items} />;
}

export function JobInvitationInboxView({
  items,
}: {
  readonly items: readonly InvitationListView[];
}) {
  if (items.length === 0)
    return (
      <EmptyState
        description={
          <p>Nové pozvania k dopytom sa zobrazia na tomto mieste.</p>
        }
        title="Zatiaľ nemáte žiadne pozvania"
      />
    );
  return (
    <ul className="participant-invitation-list" aria-label="Pozvania">
      {items.map((item) => {
        const presentation = invitationStatePresentation(item.state);
        return (
          <li key={item.id}>
            <Card>
              <StatusBadge tone={presentation.tone}>
                {presentation.label}
              </StatusBadge>
              <h2>{item.requestTitle}</h2>
              <p>{item.counterpartDisplayName}</p>
              <p>
                Posledná aktivita:{" "}
                <time dateTime={item.changedAt}>
                  {new Date(item.changedAt).toLocaleDateString("sk-SK")}
                </time>
              </p>
              <ActionLink href={`/invitations/${encodeURIComponent(item.id)}`}>
                Otvoriť pozvanie
              </ActionLink>
            </Card>
          </li>
        );
      })}
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

function invitationStatePresentation(state: string): {
  readonly label: string;
  readonly tone: "default" | "success" | "warning" | "trust";
} {
  return (
    (
      {
        DECLINED: { label: "Pozvanie bolo odmietnuté", tone: "default" },
        ENGAGED: { label: "Záujem potvrdený", tone: "success" },
        EXPIRED: { label: "Platnosť vypršala", tone: "default" },
        NOT_SELECTED: {
          label: "Toto pozvanie už nie je vo výbere",
          tone: "default",
        },
        PENDING: { label: "Čaká na rozhodnutie", tone: "warning" },
        WITHDRAWN: { label: "Pozvanie bolo stiahnuté", tone: "default" },
      } as const satisfies Record<
        string,
        {
          readonly label: string;
          readonly tone: "default" | "success" | "warning" | "trust";
        }
      >
    )[state] ?? { label: "Stav nie je dostupný", tone: "default" }
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
