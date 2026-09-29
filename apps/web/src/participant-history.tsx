"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  ActionLink,
  Button,
  Card,
  EmptyState,
  Notice,
  StatusBadge,
} from "./design-system";

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

type State = "ACCEPTED" | "DECLINED" | "LEFT" | "REMOVED";
export interface ParticipationHistoryItem {
  readonly participantId: string;
  readonly jobId: string;
  readonly providerDisplayName: string;
  readonly municipalityName: string;
  readonly primaryProfessionCode: string;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly leftAt: string | null;
  readonly jobState:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  readonly state: State;
}
export interface ParticipationHistoryPage {
  readonly items: readonly ParticipationHistoryItem[];
  readonly nextCursor: {
    readonly invitedAt: string;
    readonly id: string;
  } | null;
}

export function parseParticipationHistoryPage(
  value: unknown,
): ParticipationHistoryPage | null {
  if (
    !record(value) ||
    !exact(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20
  )
    return null;
  const ids = new Set<string>();
  const items: ParticipationHistoryItem[] = [];
  for (const item of value.items as unknown[]) {
    if (
      !record(item) ||
      !exact(item, [
        "participantId",
        "jobId",
        "providerDisplayName",
        "municipalityName",
        "primaryProfessionCode",
        "invitedAt",
        "acceptedAt",
        "leftAt",
        "jobState",
        "state",
      ]) ||
      typeof item.participantId !== "string" ||
      !uuid.test(item.participantId) ||
      ids.has(item.participantId) ||
      typeof item.jobId !== "string" ||
      !uuid.test(item.jobId) ||
      typeof item.providerDisplayName !== "string" ||
      item.providerDisplayName.trim().length < 1 ||
      item.providerDisplayName.length > 255 ||
      /[\p{Cc}]/u.test(item.providerDisplayName) ||
      typeof item.municipalityName !== "string" ||
      item.municipalityName.trim().length < 1 ||
      item.municipalityName.length > 200 ||
      typeof item.primaryProfessionCode !== "string" ||
      !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(
        item.primaryProfessionCode,
      ) ||
      !isoDate(item.invitedAt) ||
      (item.acceptedAt !== null && !isoDate(item.acceptedAt)) ||
      (item.leftAt !== null && !isoDate(item.leftAt)) ||
      ![
        "CONFIRMED",
        "IN_PROGRESS",
        "COMPLETION_REQUESTED",
        "COMPLETED",
        "CANCELLED",
      ].includes(String(item.jobState)) ||
      !["ACCEPTED", "DECLINED", "LEFT", "REMOVED"].includes(
        String(item.state),
      ) ||
      (item.state === "DECLINED" &&
        (item.acceptedAt !== null || item.leftAt !== null)) ||
      (item.state !== "DECLINED" && item.acceptedAt === null) ||
      (item.state === "ACCEPTED" && item.leftAt !== null) ||
      ((item.state === "LEFT" || item.state === "REMOVED") &&
        item.leftAt === null) ||
      (item.acceptedAt !== null &&
        Date.parse(item.acceptedAt) < Date.parse(item.invitedAt)) ||
      (item.leftAt !== null &&
        item.acceptedAt !== null &&
        Date.parse(item.leftAt) < Date.parse(item.acceptedAt))
    )
      return null;
    ids.add(item.participantId);
    items.push(item as unknown as ParticipationHistoryItem);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exact(cursor, ["invitedAt", "id"]) ||
      !isoDate(cursor.invitedAt) ||
      typeof cursor.id !== "string" ||
      !uuid.test(cursor.id) ||
      cursor.id !== items.at(-1)?.participantId ||
      cursor.invitedAt !== items.at(-1)?.invitedAt)
  )
    return null;
  return { items, nextCursor: cursor } as ParticipationHistoryPage;
}

export async function loadParticipationHistory(input: {
  readonly fetch: typeof fetch;
  readonly cursor?: ParticipationHistoryPage["nextCursor"];
}): Promise<
  | { readonly status: "OK"; readonly page: ParticipationHistoryPage }
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
      `/v1/me/job-participations/history?${query.toString()}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseParticipationHistoryPage(await response.json());
    return page === null ? { status: "UNAVAILABLE" } : { status: "OK", page };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function leaveParticipation(input: {
  readonly fetch: typeof fetch;
  readonly participantId: string;
  readonly commandId: string;
}): Promise<"OK" | "AUTH_REQUIRED" | "UNAVAILABLE"> {
  if (!uuid.test(input.participantId) || !uuid.test(input.commandId))
    return "UNAVAILABLE";
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return "AUTH_REQUIRED";
    if (!csrfResponse.ok) return "UNAVAILABLE";
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exact(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000
    )
      return "UNAVAILABLE";
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/decision`,
      {
        body: JSON.stringify({ commandId: input.commandId, decision: "LEAVE" }),
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
    if (response.status === 401) return "AUTH_REQUIRED";
    if (!response.ok) return "UNAVAILABLE";
    const body: unknown = await response.json();
    return record(body) &&
      exact(body, ["status", "state", "recordedAt"]) &&
      (body.status === "APPLIED" || body.status === "DEDUPLICATED") &&
      body.state === "LEFT" &&
      isoDate(body.recordedAt)
      ? "OK"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

const labels: Record<State, string> = {
  ACCEPTED: "Potvrdená účasť",
  DECLINED: "Pozvanie bolo odmietnuté",
  LEFT: "Účasť ste ukončili",
  REMOVED: "Účasť ukončil hlavný poskytovateľ",
};

const tones: Record<State, "default" | "success" | "warning" | "trust"> = {
  ACCEPTED: "success",
  DECLINED: "default",
  LEFT: "default",
  REMOVED: "default",
};

const jobStateLabels: Record<ParticipationHistoryItem["jobState"], string> = {
  CONFIRMED: "Zákazka je potvrdená",
  IN_PROGRESS: "Práce prebiehajú",
  COMPLETION_REQUESTED: "Čaká sa na potvrdenie dokončenia",
  COMPLETED: "Zákazka je dokončená",
  CANCELLED: "Zákazka bola zrušená",
};

export function participationCapabilityHref(
  item: ParticipationHistoryItem,
): string | null {
  return item.state === "DECLINED"
    ? null
    : `/ucasti/schopnosti/${item.participantId}`;
}

export function ParticipantHistory() {
  const [page, setPage] = useState<ParticipationHistoryPage | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "UNAVAILABLE"
  >("LOADING");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retryIds = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    void loadParticipationHistory({ fetch: globalThis.fetch }).then(
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

  const leave = async (participantId: string) => {
    if (busyId !== null) return;
    setBusyId(participantId);
    setError(null);
    const commandId =
      retryIds.current.get(participantId) ?? crypto.randomUUID();
    retryIds.current.set(participantId, commandId);
    const result = await leaveParticipation({
      fetch: globalThis.fetch,
      participantId,
      commandId,
    });
    if (result === "OK") {
      const refreshed = await loadParticipationHistory({
        fetch: globalThis.fetch,
      });
      if (refreshed.status === "OK") {
        retryIds.current.delete(participantId);
        setPage(refreshed.page);
        setNotice("Vaša účasť sa ukončila; história zostáva zachovaná.");
      } else {
        setPage(null);
        setStatus("UNAVAILABLE");
      }
    } else {
      setError(
        result === "AUTH_REQUIRED"
          ? "Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova."
          : "Výsledok sa nepodarilo overiť. Skúste ukončenie zopakovať.",
      );
    }
    setBusyId(null);
  };

  const more = async () => {
    if (!page?.nextCursor || loadingMore || busyId !== null) return;
    setLoadingMore(true);
    const result = await loadParticipationHistory({
      fetch: globalThis.fetch,
      cursor: page.nextCursor,
    });
    if (
      result.status !== "OK" ||
      result.page.items.some((item) =>
        page.items.some((old) => old.participantId === item.participantId),
      )
    )
      setError("Ďalšie záznamy sa nepodarilo bezpečne načítať.");
    else
      setPage({
        items: [...page.items, ...result.page.items],
        nextCursor: result.page.nextCursor,
      });
    setLoadingMore(false);
  };

  if (status === "LOADING")
    return <p role="status">Načítavam vašu históriu…</p>;
  if (status !== "OK" || page === null)
    return (
      <p role="alert">
        {status === "AUTH_REQUIRED"
          ? "Na zobrazenie histórie sa prihláste."
          : "Históriu sa nepodarilo načítať. Skúste to znova neskôr."}
      </p>
    );
  return (
    <ParticipationHistoryView
      busyId={busyId}
      error={error}
      loadingMore={loadingMore}
      notice={notice}
      onLeave={(participantId) => void leave(participantId)}
      onMore={() => void more()}
      page={page}
    />
  );
}

export function ParticipationHistoryView({
  busyId,
  error,
  loadingMore,
  notice,
  onLeave,
  onMore,
  page,
}: {
  readonly busyId: string | null;
  readonly error: string | null;
  readonly loadingMore: boolean;
  readonly notice: string | null;
  readonly onLeave: (participantId: string) => void;
  readonly onMore: () => void;
  readonly page: ParticipationHistoryPage;
}) {
  return (
    <section aria-label="Moja história účasti">
      {notice && (
        <Notice tone="success">
          <p role="status">{notice}</p>
        </Notice>
      )}
      {error && (
        <Notice tone="error">
          <p role="alert">{error}</p>
        </Notice>
      )}
      {page.items.length === 0 && (
        <EmptyState
          action={
            <ActionLink href="/ucasti/pozvanky">Čakajúce pozvánky</ActionLink>
          }
          description={
            <p>Prijaté, odmietnuté a ukončené účasti sa zobrazia tu.</p>
          }
          title="Zatiaľ nemáte históriu účasti"
        />
      )}
      <ul className="participant-invitation-list">
        {page.items.map((item) => (
          <li key={item.participantId}>
            <Card>
              <StatusBadge tone={tones[item.state]}>
                {labels[item.state]}
              </StatusBadge>{" "}
              <StatusBadge tone="trust">
                {jobStateLabels[item.jobState]}
              </StatusBadge>
              <h2>Účasť na zákazke</h2>
              <p>Hlavný poskytovateľ: {item.providerDisplayName}</p>
              <p>Obec zákazky: {item.municipalityName}</p>
              <p>
                Pozvanie prišlo:{" "}
                <time dateTime={item.invitedAt}>
                  {new Date(item.invitedAt).toLocaleString("sk-SK")}
                </time>
              </p>
              {item.acceptedAt && (
                <p>
                  Prijaté:{" "}
                  <time dateTime={item.acceptedAt}>
                    {new Date(item.acceptedAt).toLocaleString("sk-SK")}
                  </time>
                </p>
              )}
              {item.leftAt && (
                <p>
                  Ukončené:{" "}
                  <time dateTime={item.leftAt}>
                    {new Date(item.leftAt).toLocaleString("sk-SK")}
                  </time>
                </p>
              )}
              {participationCapabilityHref(item) && (
                <ActionLink
                  href={participationCapabilityHref(item) ?? "#"}
                  variant="secondary"
                >
                  Profesie a zručnosti na zákazke
                </ActionLink>
              )}
              {item.state === "ACCEPTED" &&
                (item.jobState === "CONFIRMED" ||
                  item.jobState === "IN_PROGRESS") && (
                  <Button
                    disabled={busyId !== null}
                    onClick={() => onLeave(item.participantId)}
                    type="button"
                    variant="destructive"
                  >
                    {busyId === item.participantId
                      ? "Ukončujem…"
                      : "Ukončiť moju účasť"}
                  </Button>
                )}
            </Card>
          </li>
        ))}
      </ul>
      {page.nextCursor && (
        <Button
          disabled={loadingMore || busyId !== null}
          onClick={onMore}
          type="button"
          variant="secondary"
        >
          {loadingMore ? "Načítavam…" : "Načítať ďalšiu históriu"}
        </Button>
      )}
    </section>
  );
}
