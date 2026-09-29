"use client";

import React, { useCallback, useEffect, useState } from "react";

import {
  ActionLink,
  Button,
  Card,
  EmptyState,
  Input,
  Notice,
  StatusBadge,
} from "./design-system";

type Filter = "ALL" | "UNREAD";
interface NotificationItem {
  readonly id: string;
  readonly type: string;
  readonly category: string;
  readonly title: string;
  readonly body: string;
  readonly priority: "INFO" | "IMPORTANT" | "CRITICAL";
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly context: {
    readonly entityType: string;
    readonly entityId: string;
    readonly path: string;
  };
}
interface Preference {
  readonly category: string;
  readonly emailEnabled: boolean;
  readonly requiredEmailMayOverride: boolean;
}
type LoadState =
  | { readonly status: "LOADING" | "ERROR" }
  | { readonly status: "READY"; readonly items: readonly NotificationItem[] };

export function NotificationCenter() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [state, setState] = useState<LoadState>({ status: "LOADING" });
  const [preferences, setPreferences] = useState<readonly Preference[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState({ status: "LOADING" });
    try {
      const [listResponse, preferenceResponse] = await Promise.all([
        fetch(`/v1/me/notifications?filter=${filter}&limit=100`, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
        fetch("/v1/me/notifications/preferences", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      ]);
      const items = listResponse.ok
        ? parseNotificationItems(await listResponse.json())
        : null;
      const parsedPreferences = preferenceResponse.ok
        ? parsePreferences(await preferenceResponse.json())
        : null;
      if (items === null || parsedPreferences === null)
        throw new Error("invalid response");
      setPreferences(parsedPreferences);
      setState({ status: "READY", items });
    } catch {
      setState({ status: "ERROR" });
    }
  }, [filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function mutate(path: string, method = "POST", body?: object) {
    setNotice(null);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "x-csrf-token": await csrf(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error("mutation failed");
      window.dispatchEvent(new Event("notifications-changed"));
      await reload();
    } catch {
      setNotice("Zmenu sa nepodarilo bezpečne uložiť. Skúste to znova.");
    }
  }

  return (
    <div className="notification-center">
      <Notice title="Toto je váš hlavný prehľad upozornení" tone="trust">
        <p>
          Upozornenia odkazujú na aktuálny kontext. Otvorenie ani označenie ako
          prečítané nikdy nepotvrdzuje ponuku, zmenu či iný obchodný krok.
        </p>
      </Notice>
      <div
        aria-label="Filter upozornení"
        className="notification-center__toolbar notification-filters"
        role="group"
      >
        <Button
          aria-pressed={filter === "ALL"}
          onClick={() => setFilter("ALL")}
          type="button"
          variant={filter === "ALL" ? "primary" : "quiet"}
        >
          Všetky
        </Button>
        <Button
          aria-pressed={filter === "UNREAD"}
          onClick={() => setFilter("UNREAD")}
          type="button"
          variant={filter === "UNREAD" ? "primary" : "quiet"}
        >
          Neprečítané
        </Button>
        <Button
          type="button"
          onClick={() => void mutate("/v1/me/notifications/read-all")}
          variant="secondary"
        >
          Označiť všetky ako prečítané
        </Button>
      </div>
      {notice ? (
        <Notice title="Nastavenie sa neuložilo" tone="error">
          <p role="status">{notice}</p>
        </Notice>
      ) : null}
      <div
        aria-labelledby="notification-inbox-title"
        className="notification-center__content"
        role="region"
      >
        <h2 className="visually-hidden" id="notification-inbox-title">
          Doručené upozornenia
        </h2>
        {state.status === "LOADING" ? (
          <Notice title="Načítavam inbox" tone="trust">
            <p aria-live="polite">Načítavam upozornenia…</p>
          </Notice>
        ) : null}
        {state.status === "ERROR" ? (
          <Notice title="Inbox nie je dostupný" tone="error">
            <p aria-live="polite">
              Upozornenia teraz nie sú dostupné. Skúste stránku obnoviť.
            </p>
          </Notice>
        ) : null}
        {state.status === "READY" && state.items.length === 0 ? (
          <EmptyState
            description={
              filter === "UNREAD"
                ? "Všetky upozornenia máte prečítané."
                : "Keď nastane udalosť súvisiaca s vaším účtom alebo zákazkou, zobrazí sa tu."
            }
            title={
              filter === "UNREAD"
                ? "Žiadne neprečítané upozornenia"
                : "Zatiaľ bez upozornení"
            }
          />
        ) : null}
        {state.status === "READY" && state.items.length > 0 ? (
          <ol className="notification-list">
            {state.items.map((item) => (
              <li key={item.id}>
                <Card
                  className={`notification-card${
                    item.readAt === null
                      ? " notification-card--unread notification-unread"
                      : ""
                  }`}
                >
                  <header className="notification-card__header">
                    <div>
                      <p className="ui-eyebrow">
                        {categoryLabel(item.category)}
                      </p>
                      <h2>{item.title}</h2>
                    </div>
                    <div className="notification-card__badges">
                      {item.readAt === null ? (
                        <StatusBadge tone="trust">Neprečítané</StatusBadge>
                      ) : null}
                      <StatusBadge tone={priorityTone(item.priority)}>
                        {priorityLabel(item.priority)}
                      </StatusBadge>
                    </div>
                  </header>
                  <p>{item.body}</p>
                  <p className="notification-card__meta">
                    <span>{entityLabel(item.context.entityType)}</span>
                    {" · "}
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString("sk-SK")}
                    </time>
                  </p>
                  <div className="notification-card__actions notification-actions">
                    <ActionLink href={item.context.path}>
                      Otvoriť súvisiaci detail
                    </ActionLink>
                    {item.readAt === null ? (
                      <Button
                        type="button"
                        onClick={() =>
                          void mutate(
                            `/v1/me/notifications/${encodeURIComponent(item.id)}/read`,
                          )
                        }
                        variant="secondary"
                      >
                        Označiť ako prečítané
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      onClick={() =>
                        void mutate(
                          `/v1/me/notifications/${encodeURIComponent(item.id)}/archive`,
                        )
                      }
                      variant="quiet"
                    >
                      Skryť z prehľadu
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <Card className="notification-preferences">
        <h2>E-mailové nastavenia</h2>
        <p>
          Upozornenia v portáli zostávajú zapnuté. Môžete upraviť bežné e-maily
          podľa kategórie, no povinné transakčné a bezpečnostné správy sa
          doručia aj pri vypnutej kategórii.
        </p>
        <div className="notification-preferences__list">
          {preferences.map((preference) => (
            <label
              className="notification-preferences__option"
              key={preference.category}
            >
              <Input
                checked={preference.emailEnabled}
                type="checkbox"
                onChange={(event) =>
                  void mutate(
                    `/v1/me/notifications/preferences/${preference.category}`,
                    "PUT",
                    { emailEnabled: event.target.checked },
                  )
                }
              />
              <span>
                <strong>{categoryLabel(preference.category)} e-mailom</strong>
                {preference.requiredEmailMayOverride ? (
                  <StatusBadge tone="warning">
                    Povinné udalosti ostanú zapnuté
                  </StatusBadge>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function parseNotificationItems(
  value: unknown,
): readonly NotificationItem[] | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  const items: NotificationItem[] = [];
  for (const item of value.items) {
    if (
      !record(item) ||
      !exactKeys(item, [
        "body",
        "category",
        "context",
        "createdAt",
        "id",
        "priority",
        "readAt",
        "title",
        "type",
      ]) ||
      !uuid(item.id) ||
      typeof item.type !== "string" ||
      typeof item.category !== "string" ||
      typeof item.title !== "string" ||
      typeof item.body !== "string" ||
      !["INFO", "IMPORTANT", "CRITICAL"].includes(String(item.priority)) ||
      !date(item.createdAt) ||
      !(item.readAt === null || date(item.readAt)) ||
      !record(item.context) ||
      !exactKeys(item.context, ["entityId", "entityType", "path"]) ||
      typeof item.context.entityType !== "string" ||
      typeof item.context.entityId !== "string" ||
      typeof item.context.path !== "string" ||
      !/^\/[A-Za-z0-9/_-]+$/u.test(item.context.path)
    )
      return null;
    items.push(item as unknown as NotificationItem);
  }
  return items;
}
export function parsePreferences(value: unknown): readonly Preference[] | null {
  if (!record(value) || !Array.isArray(value.preferences)) return null;
  const preferences: Preference[] = [];
  for (const preference of value.preferences) {
    if (
      !record(preference) ||
      !exactKeys(preference, [
        "category",
        "emailEnabled",
        "requiredEmailMayOverride",
      ]) ||
      typeof preference.category !== "string" ||
      typeof preference.emailEnabled !== "boolean" ||
      typeof preference.requiredEmailMayOverride !== "boolean"
    )
      return null;
    preferences.push(preference as unknown as Preference);
  }
  return preferences;
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
function categoryLabel(value: string): string {
  return (
    {
      CHAT: "Správy",
      MARKETPLACE: "Dopyty a ponuky",
      JOB_OPERATIONS: "Realizácia zákazky",
      REVIEWS: "Hodnotenia",
      ACCOUNT_SECURITY: "Účet a bezpečnosť",
    }[value] ?? "Upozornenie"
  );
}
function priorityLabel(value: NotificationItem["priority"]): string {
  return { INFO: "Informácia", IMPORTANT: "Dôležité", CRITICAL: "Kritické" }[
    value
  ];
}
function priorityTone(
  value: NotificationItem["priority"],
): "default" | "error" | "warning" {
  return value === "CRITICAL"
    ? "error"
    : value === "IMPORTANT"
      ? "warning"
      : "default";
}
function entityLabel(value: string): string {
  return (
    {
      JOB: "Zákazka",
      JOB_REQUEST: "Dopyt",
      JOB_INVITATION: "Pozvánka",
      QUOTE: "Ponuka",
      CONVERSATION: "Konverzácia",
      CHANGE_ORDER_REVISION: "Zmena zákazky",
      DISPUTE_CASE: "Sporný prípad",
      CREDENTIAL_CLAIM: "Profesijný doklad",
      CRAFTSMAN_PROFILE: "Profil",
      MODERATION_ACTION: "Opatrenie",
      MODERATION_APPEAL: "Odvolanie",
      REVIEW_RESPONSE: "Odpoveď na hodnotenie",
      SUPERVISOR_EVALUATION: "Technické hodnotenie",
      JOB_PARTICIPANT: "Účastník",
    }[value] ?? "Súvisiaci záznam"
  );
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
