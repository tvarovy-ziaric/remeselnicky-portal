"use client";

import React, { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  Button,
  Card,
  EmptyState,
  FormField,
  Notice,
  PageHeader,
  StatusBadge,
  Textarea,
} from "./design-system";

interface ModerationActionView {
  readonly actionId: string;
  readonly action: string;
  readonly targetType: string;
  readonly enforcementScope: string;
  readonly restrictionExpiresAt: string | null;
  readonly policyCategory: string;
  readonly userFacingReason: string;
  readonly appliedAt: string;
  readonly active: boolean;
  readonly appealId: string | null;
  readonly appealState: string | null;
}

type LoadState =
  | { status: "LOADING" }
  | { status: "ERROR" }
  | { status: "READY"; items: readonly ModerationActionView[] };

export function ModerationActions() {
  const [state, setState] = useState<LoadState>({ status: "LOADING" });
  const [selected, setSelected] = useState<string | null>(null);
  const [explanation, setExplanation] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    setState({ status: "LOADING" });
    try {
      const response = await fetch("/v1/me/moderation/actions", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return setState({ status: "ERROR" });
      const items = parseActions(await response.json());
      setState(
        items === null ? { status: "ERROR" } : { status: "READY", items },
      );
    } catch {
      setState({ status: "ERROR" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function submitAppeal(event: FormEvent) {
    event.preventDefault();
    if (selected === null || explanation.trim().length < 1) return;
    setPending(true);
    setNotice(null);
    try {
      const token = await csrf();
      const response = await fetch(
        `/v1/me/moderation/actions/${encodeURIComponent(selected)}/appeals`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": token,
          },
          body: JSON.stringify({
            appealId: crypto.randomUUID(),
            explanation: explanation.trim(),
          }),
        },
      );
      if (!response.ok) throw new Error("appeal failed");
      setExplanation("");
      setSelected(null);
      setNotice(
        "Žiadosť o opätovné posúdenie bola odoslaná. Opatrenie zostáva dovtedy účinné.",
      );
      await reload();
    } catch {
      setNotice("Odvolanie sa nepodarilo bezpečne odoslať. Skúste to znova.");
    } finally {
      setPending(false);
    }
  }

  if (state.status === "LOADING")
    return <p aria-live="polite">Načítavam opatrenia…</p>;
  if (state.status === "ERROR")
    return <p aria-live="polite">Opatrenia teraz nie sú dostupné.</p>;
  return (
    <section className="moderation-account">
      <PageHeader
        eyebrow="Bezpečnosť účtu"
        lead={
          <p>
            Tu vidíte opatrenia, ktoré sa týkajú vášho účtu alebo obsahu, a ich
            zachovanú históriu.
          </p>
        }
        title="Moderovanie a odvolania"
      />
      <ModerationBoundaryNotice />
      {notice ? <p role="status">{notice}</p> : null}
      {state.items.length === 0 ? (
        <EmptyState
          description="Na vašom účte ani obsahu neevidujeme moderátorské opatrenie."
          title="Žiadne aktívne opatrenia"
        />
      ) : (
        <ol className="moderation-action-list">
          {state.items.map((item) => (
            <li key={item.actionId}>
              <Card className="moderation-action-card">
                <p className="ui-eyebrow">
                  {policyCategoryLabel(item.policyCategory)}
                </p>
                <h2>{actionLabel(item.action)}</h2>
                <StatusBadge tone={item.active ? "warning" : "default"}>
                  {item.active ? "Aktívne" : "Ukončené"}
                </StatusBadge>
                <p>{item.userFacingReason}</p>
                <dl>
                  <dt>Rozsah</dt>
                  <dd>{scopeLabel(item.enforcementScope)}</dd>
                  <dt>Stav</dt>
                  <dd>{item.active ? "Aktívne" : "Ukončené"}</dd>
                  {item.restrictionExpiresAt ? (
                    <>
                      <dt>Platí do</dt>
                      <dd>
                        {new Date(item.restrictionExpiresAt).toLocaleString(
                          "sk-SK",
                        )}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {item.appealId ? (
                  <p>Odvolanie: {appealLabel(item.appealState)}</p>
                ) : (
                  <Button
                    type="button"
                    onClick={() => setSelected(item.actionId)}
                    variant="secondary"
                  >
                    Požiadať o opätovné posúdenie
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}
      {selected ? (
        <Card className="moderation-appeal-card">
          <form onSubmit={(event) => void submitAppeal(event)}>
            <h2>Žiadosť o opätovné posúdenie</h2>
            <FormField
              description="Uveďte nové skutočnosti alebo vysvetlenie. Pôvodné opatrenie a história zostanú zachované."
              label="Vysvetlenie alebo nové skutočnosti"
            >
              <Textarea
                id="moderation-appeal-explanation"
                maxLength={4_000}
                required
                value={explanation}
                onChange={(event) => setExplanation(event.target.value)}
              />
            </FormField>
            <Button disabled={pending} type="submit">
              {pending ? "Odosielam…" : "Odoslať odvolanie"}
            </Button>
            <Button
              disabled={pending}
              type="button"
              onClick={() => setSelected(null)}
              variant="quiet"
            >
              Zrušiť
            </Button>
          </form>
        </Card>
      ) : null}
    </section>
  );
}

export function parseActions(
  value: unknown,
): readonly ModerationActionView[] | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  const items: ModerationActionView[] = [];
  for (const item of value.items) {
    if (
      !record(item) ||
      !uuid(item.actionId) ||
      typeof item.action !== "string" ||
      typeof item.targetType !== "string" ||
      typeof item.enforcementScope !== "string" ||
      typeof item.policyCategory !== "string" ||
      typeof item.userFacingReason !== "string" ||
      typeof item.active !== "boolean" ||
      !date(item.appliedAt) ||
      !(
        item.restrictionExpiresAt === null || date(item.restrictionExpiresAt)
      ) ||
      !(item.appealId === null || uuid(item.appealId)) ||
      !(
        item.appealState === null ||
        (typeof item.appealState === "string" &&
          ["OPEN", "UPHELD", "REDUCED", "REVERSED"].includes(item.appealState))
      )
    )
      return null;
    items.push(item as unknown as ModerationActionView);
  }
  return items;
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

function actionLabel(value: string): string {
  return (
    {
      APPLY_WARNING: "Upozornenie",
      HIDE_CONTENT: "Skrytie obsahu",
      EXCLUDE_REVIEW_EVIDENCE: "Vylúčenie hodnotenia z reputácie",
      APPLY_FEATURE_RESTRICTION: "Obmedzenie funkcie",
      APPLY_TEMPORARY_SUSPENSION: "Dočasné obmedzenie",
      APPLY_INDEFINITE_SUSPENSION: "Pozastavenie účtu",
    }[value] ?? "Moderátorské opatrenie"
  );
}
function scopeLabel(value: string): string {
  return (
    {
      CONTENT: "obsah",
      MESSAGING: "správy",
      PUBLISHING: "publikovanie",
      QUOTING: "ponuky",
      REVIEWS: "hodnotenia",
      ACCOUNT: "účet",
    }[value] ?? "iný rozsah"
  );
}

function policyCategoryLabel(value: string): string {
  return (
    {
      HARASSMENT_ABUSE: "Obťažovanie alebo zneužitie",
      IMPERSONATION_MISREPRESENTATION: "Vydávanie sa za inú osobu",
      INAPPROPRIATE_CONTENT: "Nevhodný obsah",
      PERSONAL_DATA_PRIVACY: "Súkromie a osobné údaje",
      SPAM_SCAM: "Spam alebo podvod",
    }[value] ?? "Pravidlá platformy"
  );
}

export function ModerationBoundaryNotice() {
  return (
    <Notice title="Opätovné posúdenie zachováva históriu">
      <p>
        Odvolanie opatrenie automaticky neruší. Tím ho samostatne preskúma;
        bežný spor o cenu alebo kvalitu práce patrí do procesu sporného prípadu,
        nie do moderovania.
      </p>
    </Notice>
  );
}
function appealLabel(value: string | null): string {
  return (
    {
      OPEN: "čaká na posúdenie",
      UPHELD: "opatrenie potvrdené",
      REDUCED: "opatrenie zmiernené",
      REVERSED: "opatrenie zrušené",
    }[value ?? ""] ?? "neznámy stav"
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
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
