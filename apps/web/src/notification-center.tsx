"use client";

import { useCallback, useEffect, useState } from "react";

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
    <section
      aria-labelledby="notification-title"
      className="notification-center"
    >
      <p className="eyebrow">Účet</p>
      <h1 id="notification-title">Upozornenia</h1>
      <p>
        Tu nájdete bezpečné odkazy na dôležité udalosti. Otvorenie upozornenia
        nikdy nepotvrdzuje obchodný krok.
      </p>
      <div aria-label="Filter upozornení" className="notification-filters">
        <button
          aria-pressed={filter === "ALL"}
          type="button"
          onClick={() => setFilter("ALL")}
        >
          Všetky
        </button>
        <button
          aria-pressed={filter === "UNREAD"}
          type="button"
          onClick={() => setFilter("UNREAD")}
        >
          Neprečítané
        </button>
        <button
          type="button"
          onClick={() => void mutate("/v1/me/notifications/read-all")}
        >
          Označiť všetky ako prečítané
        </button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {state.status === "LOADING" ? (
        <p aria-live="polite">Načítavam upozornenia…</p>
      ) : null}
      {state.status === "ERROR" ? (
        <p aria-live="polite">Upozornenia teraz nie sú dostupné.</p>
      ) : null}
      {state.status === "READY" && state.items.length === 0 ? (
        <p>Nemáte žiadne upozornenia v tomto filtri.</p>
      ) : null}
      {state.status === "READY" && state.items.length > 0 ? (
        <ol className="notification-list">
          {state.items.map((item) => (
            <li
              key={item.id}
              className={item.readAt === null ? "notification-unread" : ""}
            >
              <article>
                <p className="eyebrow">
                  {categoryLabel(item.category)} ·{" "}
                  {priorityLabel(item.priority)}
                </p>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
                <p>
                  <span>{entityLabel(item.context.entityType)}</span>
                  {" · "}
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString("sk-SK")}
                  </time>
                </p>
                <div className="notification-actions">
                  <a href={item.context.path}>Otvoriť detail</a>
                  {item.readAt === null ? (
                    <button
                      type="button"
                      onClick={() =>
                        void mutate(
                          `/v1/me/notifications/${encodeURIComponent(item.id)}/read`,
                        )
                      }
                    >
                      Označiť ako prečítané
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      void mutate(
                        `/v1/me/notifications/${encodeURIComponent(item.id)}/archive`,
                      )
                    }
                  >
                    Skryť
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ol>
      ) : null}
      <section
        aria-labelledby="notification-preferences-title"
        className="notification-preferences"
      >
        <h2 id="notification-preferences-title">E-mailové nastavenia</h2>
        <p>
          In-app upozornenia zostávajú zapnuté. Povinné transakčné a
          bezpečnostné e-maily môžu nastavenie kategórie prekryť.
        </p>
        {preferences.map((preference) => (
          <label key={preference.category}>
            <input
              type="checkbox"
              checked={preference.emailEnabled}
              onChange={(event) =>
                void mutate(
                  `/v1/me/notifications/preferences/${preference.category}`,
                  "PUT",
                  { emailEnabled: event.target.checked },
                )
              }
            />
            {categoryLabel(preference.category)} e-mailom
            {preference.requiredEmailMayOverride
              ? " (povinné udalosti sa doručia vždy)"
              : ""}
          </label>
        ))}
      </section>
    </section>
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
      !uuid(item.id) ||
      typeof item.type !== "string" ||
      typeof item.category !== "string" ||
      typeof item.title !== "string" ||
      typeof item.body !== "string" ||
      !["INFO", "IMPORTANT", "CRITICAL"].includes(String(item.priority)) ||
      !date(item.createdAt) ||
      !(item.readAt === null || date(item.readAt)) ||
      !record(item.context) ||
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
  return { INFO: "informácia", IMPORTANT: "dôležité", CRITICAL: "kritické" }[
    value
  ];
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
