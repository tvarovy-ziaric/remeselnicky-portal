"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

export interface AdminProfileReviewItem {
  readonly about: string | null;
  readonly baseMunicipality: Readonly<{
    readonly code: string;
    readonly name: string;
  }> | null;
  readonly identity: Readonly<{
    readonly primaryName: string | null;
    readonly profileType: "INDIVIDUAL" | "COMPANY";
    readonly secondaryName: string | null;
  }>;
  readonly normalRadiusMeters: number | null;
  readonly professions: readonly Readonly<{
    readonly code: string;
    readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
    readonly label: string;
  }>[];
  readonly profileId: string;
  readonly publicationRevision: number;
  readonly readiness: Readonly<{
    readonly isReady: boolean;
    readonly missing: readonly string[];
  }>;
  readonly submittedAt: string;
}

export interface AdminProfileReviewPage {
  readonly items: readonly AdminProfileReviewItem[];
  readonly nextCursor: string | null;
}

type LoadResult =
  | { readonly page: AdminProfileReviewPage; readonly status: "OK" }
  | { readonly status: "AUTH_REQUIRED" | "DENIED" | "UNAVAILABLE" };
type DecisionResult =
  "OK" | "AUTH_REQUIRED" | "DENIED" | "STALE" | "UNAVAILABLE";

const queuePath = "/v1/admin/craftsman-profiles/review-queue";

export async function loadAdminProfileReviewQueue(
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<LoadResult> {
  try {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor !== undefined) {
      if (!uuid(cursor)) return { status: "UNAVAILABLE" };
      query.set("cursor", cursor);
    }
    const response = await fetcher(queuePath + "?" + query.toString(), {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "DENIED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseAdminProfileReviewPage(await response.json());
    return page === null ? { status: "UNAVAILABLE" } : { page, status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function parseAdminProfileReviewPage(
  value: unknown,
): AdminProfileReviewPage | null {
  if (
    !exactRecord(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || uuid(value.nextCursor))
  )
    return null;
  const items = value.items.map(parseReview);
  if (items.some((item) => item === null)) return null;
  return Object.freeze({
    items: Object.freeze(items as AdminProfileReviewItem[]),
    nextCursor: value.nextCursor,
  });
}

export async function decideAdminProfileReview(input: {
  readonly action: "approve" | "reject";
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedRevision: number;
  readonly fetch?: typeof fetch;
  readonly profileId: string;
  readonly reason: string;
}): Promise<DecisionResult> {
  if (
    !uuid(input.commandId) ||
    !uuid(input.correlationId) ||
    !uuid(input.profileId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.reason !== input.reason.trim() ||
    input.reason.length < 8 ||
    input.reason.length > 500 ||
    /\p{Cc}/u.test(input.reason)
  )
    return "UNAVAILABLE";
  const fetcher = input.fetch ?? fetch;
  try {
    const csrfResponse = await fetcher("/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (csrfResponse.status === 401) return "AUTH_REQUIRED";
    if (!csrfResponse.ok) return "UNAVAILABLE";
    const csrf: unknown = await csrfResponse.json();
    if (
      !exactRecord(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000 ||
      /\p{Cc}/u.test(csrf.csrfToken)
    )
      return "UNAVAILABLE";
    const response = await fetcher(
      "/v1/admin/craftsman-profiles/" +
        encodeURIComponent(input.profileId) +
        "/" +
        input.action,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          correlationId: input.correlationId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
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
    if (response.status === 401) return "AUTH_REQUIRED";
    if (response.status === 403) return "DENIED";
    if (response.status === 409) return "STALE";
    if (!response.ok) return "UNAVAILABLE";
    const body: unknown = await response.json();
    return validDecisionResponse(body, input.profileId) ? "OK" : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

export function AdminProfileReviewWorkspace() {
  const [page, setPage] = useState<AdminProfileReviewPage | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "DENIED" | "UNAVAILABLE"
  >("LOADING");
  const [selected, setSelected] = useState<AdminProfileReviewItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempts = useRef(
    new Map<
      string,
      { readonly commandId: string; readonly correlationId: string }
    >(),
  );

  const load = useCallback(async () => {
    const result = await loadAdminProfileReviewQueue();
    if (result.status === "OK") {
      setPage(result.page);
      setSelected((current) =>
        current === null
          ? (result.page.items[0] ?? null)
          : (result.page.items.find(
              (item) => item.profileId === current.profileId,
            ) ??
            result.page.items[0] ??
            null),
      );
    } else {
      setPage(null);
      setSelected(null);
    }
    setStatus(result.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (action: "approve" | "reject") => {
    if (selected === null || busy) return;
    const reason =
      action === "approve"
        ? "Profil spĺňa požiadavky na zverejnenie."
        : rejectReason.trim();
    if (reason.length < 8) {
      setMessage("Pri vrátení profilu zadajte zrozumiteľný dôvod.");
      return;
    }
    const key = selected.profileId + ":" + action;
    const attempt = attempts.current.get(key) ?? {
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    };
    attempts.current.set(key, attempt);
    setBusy(true);
    setMessage(null);
    const result = await decideAdminProfileReview({
      action,
      commandId: attempt.commandId,
      correlationId: attempt.correlationId,
      expectedRevision: selected.publicationRevision,
      profileId: selected.profileId,
      reason,
    });
    if (result !== "UNAVAILABLE") attempts.current.delete(key);
    if (result === "OK") {
      setRejectReason("");
      setMessage(
        action === "approve"
          ? "Profil bol schválený."
          : "Profil bol vrátený remeselníkovi.",
      );
      await load();
    } else {
      setMessage(decisionMessage(result));
    }
    setBusy(false);
  };

  if (status === "LOADING")
    return <p role="status">Načítavam profily na kontrolu…</p>;
  if (status !== "OK")
    return (
      <section className="admin-panel">
        <p className="admin-kicker">Kontrola profilov</p>
        <h2>Fronta nie je dostupná</h2>
        <p role="alert">
          {status === "AUTH_REQUIRED"
            ? "Privilegovaná relácia vypršala. Prihláste sa a dokončite MFA."
            : status === "DENIED"
              ? "Relácia nemá oprávnenie admin.profiles.review."
              : "Dáta sa nepodarilo bezpečne načítať."}
        </p>
      </section>
    );
  if (page === null || page.items.length === 0)
    return (
      <section className="admin-panel">
        <p className="admin-kicker">Kontrola profilov</p>
        <h2>Žiadne profily nečakajú</h2>
        <p role="status">Fronta profilov na schválenie je prázdna.</p>
      </section>
    );

  return (
    <section className="admin-panel admin-profile-review">
      <p className="admin-kicker">Kontrola profilov</p>
      <h2>Profily čakajúce na rozhodnutie</h2>
      <div className="admin-profile-review-layout">
        <ul
          className="admin-profile-review-queue"
          aria-label="Čakajúce profily"
        >
          {page.items.map((item) => (
            <li key={item.profileId}>
              <button
                aria-current={
                  selected?.profileId === item.profileId ? "true" : undefined
                }
                type="button"
                onClick={() => {
                  setSelected(item);
                  setMessage(null);
                }}
              >
                <strong>{item.identity.primaryName ?? "Bez názvu"}</strong>
                <span>
                  {new Date(item.submittedAt).toLocaleString("sk-SK")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {selected === null ? null : (
          <article className="admin-profile-review-detail">
            <h3>{selected.identity.primaryName ?? "Bez názvu"}</h3>
            {selected.identity.secondaryName === null ? null : (
              <p>{selected.identity.secondaryName}</p>
            )}
            <p>{selected.about ?? "Predstavenie nie je vyplnené."}</p>
            <dl>
              <div>
                <dt>Obec</dt>
                <dd>{selected.baseMunicipality?.name ?? "Neuvedená"}</dd>
              </div>
              <div>
                <dt>Bežný dojazd</dt>
                <dd>
                  {selected.normalRadiusMeters === null
                    ? "Neuvedený"
                    : Math.round(selected.normalRadiusMeters / 1_000) + " km"}
                </dd>
              </div>
            </dl>
            <h4>Profesie</h4>
            {selected.professions.length === 0 ? (
              <p>Žiadna aktívna profesia.</p>
            ) : (
              <ul>
                {selected.professions.map((profession) => (
                  <li key={profession.code}>
                    {profession.label} — {profession.declaredLevel}
                  </li>
                ))}
              </ul>
            )}
            {selected.readiness.isReady ? null : (
              <p className="profile-authoring-warning" role="alert">
                Profil už nespĺňa povinné minimum:{" "}
                {selected.readiness.missing.join(", ")}
              </p>
            )}
            <label htmlFor="profile-rejection-reason">
              Dôvod vrátenia pre remeselníka
            </label>
            <textarea
              id="profile-rejection-reason"
              maxLength={500}
              onChange={(event) => setRejectReason(event.target.value)}
              rows={4}
              value={rejectReason}
            />
            {message === null ? null : <p role="status">{message}</p>}
            <div className="admin-profile-review-actions">
              <button
                disabled={busy || !selected.readiness.isReady}
                type="button"
                onClick={() => void decide("approve")}
              >
                Schváliť profil
              </button>
              <button
                disabled={busy || rejectReason.trim().length < 8}
                type="button"
                onClick={() => void decide("reject")}
              >
                Vrátiť na úpravu
              </button>
            </div>
          </article>
        )}
      </div>
    </section>
  );
}

function parseReview(value: unknown): AdminProfileReviewItem | null {
  if (
    !exactRecord(value, [
      "about",
      "baseMunicipality",
      "identity",
      "normalRadiusMeters",
      "professions",
      "profileId",
      "publicationRevision",
      "readiness",
      "submittedAt",
    ]) ||
    !(value.about === null || boundedText(value.about, 2_000)) ||
    !uuid(value.profileId) ||
    !Number.isSafeInteger(value.publicationRevision) ||
    Number(value.publicationRevision) < 1 ||
    !(
      value.normalRadiusMeters === null || nonNegative(value.normalRadiusMeters)
    ) ||
    !iso(value.submittedAt) ||
    !parseIdentity(value.identity) ||
    !parseMunicipality(value.baseMunicipality) ||
    !Array.isArray(value.professions) ||
    value.professions.length > 64 ||
    !value.professions.every(parseProfession) ||
    !parseReadiness(value.readiness)
  )
    return null;
  return Object.freeze(value) as unknown as AdminProfileReviewItem;
}

function parseIdentity(value: unknown): boolean {
  return (
    exactRecord(value, ["primaryName", "profileType", "secondaryName"]) &&
    (value.profileType === "INDIVIDUAL" || value.profileType === "COMPANY") &&
    (value.primaryName === null || boundedText(value.primaryName, 160)) &&
    (value.secondaryName === null || boundedText(value.secondaryName, 160))
  );
}

function parseMunicipality(value: unknown): boolean {
  return (
    value === null ||
    (exactRecord(value, ["code", "name"]) &&
      municipalityCode(value.code) &&
      boundedText(value.name, 120))
  );
}

function parseProfession(value: unknown): boolean {
  return (
    exactRecord(value, ["code", "declaredLevel", "label"]) &&
    professionCode(value.code) &&
    ["BEGINNER", "ADVANCED", "MASTER"].includes(String(value.declaredLevel)) &&
    boundedText(value.label, 120)
  );
}

function parseReadiness(value: unknown): boolean {
  return (
    exactRecord(value, ["isReady", "missing"]) &&
    typeof value.isReady === "boolean" &&
    Array.isArray(value.missing) &&
    value.missing.length <= 16 &&
    value.missing.every(
      (item) =>
        typeof item === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(item),
    ) &&
    value.isReady === (value.missing.length === 0)
  );
}

function validDecisionResponse(value: unknown, profileId: string): boolean {
  return (
    exactRecord(value, ["publication", "status"]) &&
    (value.status === "APPLIED" || value.status === "DEDUPLICATED") &&
    exactRecord(value.publication, ["profileId", "revision", "reviewState"]) &&
    value.publication.profileId === profileId &&
    Number.isSafeInteger(value.publication.revision) &&
    Number(value.publication.revision) >= 1 &&
    (value.publication.reviewState === "APPROVED" ||
      value.publication.reviewState === "REJECTED")
  );
}

function decisionMessage(result: Exclude<DecisionResult, "OK">): string {
  if (result === "AUTH_REQUIRED")
    return "Privilegovaná relácia vypršala. Zopakujte MFA.";
  if (result === "DENIED") return "Na rozhodnutie nemáte aktuálne oprávnenie.";
  if (result === "STALE")
    return "Profil sa medzitým zmenil. Obnovte frontu a skontrolujte ho znova.";
  return "Výsledok sa nepodarilo overiť. Rovnaké rozhodnutie môžete zopakovať.";
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
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
function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value)
  );
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function municipalityCode(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u.test(value)
  );
}
function professionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}
