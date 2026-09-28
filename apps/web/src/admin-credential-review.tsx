"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

export const CREDENTIAL_REJECTION_CATEGORIES = Object.freeze([
  "INSUFFICIENT_EVIDENCE",
  "FALSE_QUALIFICATION",
  "FALSE_IDENTITY",
  "MISLEADING_CLAIM",
  "EXPIRED_OR_INVALID",
  "OTHER",
] as const);

export type CredentialRejectionCategory =
  (typeof CREDENTIAL_REJECTION_CATEGORIES)[number];

export interface AdminCredentialReviewItem {
  readonly claimId: string;
  readonly createdAt: string;
  readonly credentialTypeCode: string;
  readonly evidence: readonly Readonly<{
    readonly assetId: string;
    readonly attachedAt: string;
    readonly mediaKind: "DOCUMENT" | "IMAGE";
  }>[];
  readonly evidenceRequirement: "REQUIRED" | "OPTIONAL";
  readonly expiresOn: string | null;
  readonly profession: Readonly<{
    readonly code: string;
    readonly id: string;
    readonly label: string;
  }>;
  readonly profile: Readonly<{
    readonly id: string;
    readonly primaryName: string | null;
    readonly profileType: "INDIVIDUAL" | "COMPANY";
    readonly secondaryName: string | null;
  }>;
  readonly revision: number;
  readonly state: "PENDING";
  readonly updatedAt: string;
}

export interface AdminCredentialReviewPage {
  readonly items: readonly AdminCredentialReviewItem[];
  readonly nextCursor: string | null;
}

type LoadResult =
  | { readonly page: AdminCredentialReviewPage; readonly status: "OK" }
  | {
      readonly status: "AUTH_REQUIRED" | "ACCESS_DENIED" | "UNAVAILABLE";
    };

export type CredentialDecisionResult =
  | "OK"
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "STALE"
  | "UNAVAILABLE";

type CredentialDecisionInput = Readonly<{
  action: "approve" | "reject" | "revoke";
  claimId: string;
  commandId: string;
  expectedRevision: number;
  fetch?: typeof fetch;
  reason?: string;
  reasonCategory?: CredentialRejectionCategory;
}>;

const queuePath = "/v1/admin/credential-claims/review-queue";

export async function loadAdminCredentialReviewQueue(
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<LoadResult> {
  if (cursor !== undefined && !uuid(cursor)) return { status: "UNAVAILABLE" };
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== undefined) query.set("cursor", cursor);
  try {
    const response = await fetcher(queuePath + "?" + query.toString(), {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "ACCESS_DENIED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseAdminCredentialReviewPage(await response.json());
    return page === null ? { status: "UNAVAILABLE" } : { page, status: "OK" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function parseAdminCredentialReviewPage(
  value: unknown,
): AdminCredentialReviewPage | null {
  if (
    !exactRecord(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || uuid(value.nextCursor))
  )
    return null;
  const items = value.items.map(parseReviewItem);
  if (items.some((item) => item === null)) return null;
  const parsed = items as AdminCredentialReviewItem[];
  if (new Set(parsed.map(({ claimId }) => claimId)).size !== parsed.length)
    return null;
  return Object.freeze({
    items: Object.freeze(parsed),
    nextCursor: value.nextCursor,
  });
}

export function adminCredentialEvidenceHref(
  claimId: string,
  assetId: string,
): string | null {
  return uuid(claimId) && uuid(assetId)
    ? `/v1/admin/credential-claims/${encodeURIComponent(claimId)}/evidence/${encodeURIComponent(assetId)}`
    : null;
}

export function isVerifiedCredentialState(
  state: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED",
): boolean {
  return state === "APPROVED";
}

export async function decideAdminCredentialClaim(
  input: CredentialDecisionInput,
): Promise<CredentialDecisionResult> {
  const reasonRequired = input.action !== "approve";
  if (
    !uuid(input.claimId) ||
    !uuid(input.commandId) ||
    !positiveRevision(input.expectedRevision) ||
    (reasonRequired &&
      (!CREDENTIAL_REJECTION_CATEGORIES.includes(
        input.reasonCategory as CredentialRejectionCategory,
      ) ||
        !safeReviewReason(input.reason))) ||
    (!reasonRequired &&
      (input.reason !== undefined || input.reasonCategory !== undefined))
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
      !boundedText(csrf.csrfToken, 1_000)
    )
      return "UNAVAILABLE";

    const body = reasonRequired
      ? {
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          reasonCategory: input.reasonCategory,
        }
      : {
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
        };
    const response = await fetcher(
      `/v1/admin/credential-claims/${encodeURIComponent(input.claimId)}/${input.action}`,
      {
        body: JSON.stringify(body),
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
    if (response.status === 403) return "ACCESS_DENIED";
    if (response.status === 404) return "NOT_FOUND";
    if (response.status === 409) return "STALE";
    if (!response.ok) return "UNAVAILABLE";
    const result: unknown = await response.json();
    return validDecisionResponse(result, input.claimId, input.action)
      ? "OK"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

export function AdminCredentialReviewWorkspace() {
  const [page, setPage] = useState<AdminCredentialReviewPage | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "ACCESS_DENIED" | "UNAVAILABLE"
  >("LOADING");
  const [selected, setSelected] = useState<AdminCredentialReviewItem | null>(
    null,
  );
  const [reasonCategory, setReasonCategory] =
    useState<CredentialRejectionCategory>("INSUFFICIENT_EVIDENCE");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempts = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const result = await loadAdminCredentialReviewQueue();
    if (result.status === "OK") {
      setPage(result.page);
      setSelected((current) =>
        current === null
          ? (result.page.items[0] ?? null)
          : (result.page.items.find(
              ({ claimId }) => claimId === current.claimId,
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
    if (selected === null || selected.state !== "PENDING" || busy) return;
    if (
      action === "approve" &&
      selected.evidenceRequirement === "REQUIRED" &&
      selected.evidence.length === 0
    ) {
      setMessage("Povinný doklad nemožno schváliť bez priloženého dôkazu.");
      return;
    }
    const normalizedReason = reason.trim().replace(/\s+/gu, " ");
    if (action === "reject" && !safeReviewReason(normalizedReason)) {
      setMessage("Pri zamietnutí zadajte bezpečný a zrozumiteľný dôvod.");
      return;
    }
    const attemptKey = selected.claimId + ":" + action;
    const commandId = attempts.current.get(attemptKey) ?? crypto.randomUUID();
    attempts.current.set(attemptKey, commandId);
    setBusy(true);
    setMessage(null);
    const result = await decideAdminCredentialClaim({
      action,
      claimId: selected.claimId,
      commandId,
      expectedRevision: selected.revision,
      ...(action === "reject"
        ? { reason: normalizedReason, reasonCategory }
        : {}),
    });
    if (result !== "UNAVAILABLE") attempts.current.delete(attemptKey);
    if (result === "OK") {
      setReason("");
      setMessage(
        action === "approve"
          ? "Doklad bol schválený. Až teraz je overený."
          : "Tvrdenie o doklade bolo zamietnuté.",
      );
      await load();
    } else {
      setMessage(decisionMessage(result));
    }
    setBusy(false);
  };

  if (status === "LOADING")
    return <p role="status">Načítavam doklady na kontrolu…</p>;
  if (status !== "OK")
    return (
      <section className="admin-panel">
        <p className="admin-kicker">Kontrola dokladov</p>
        <h2>Fronta nie je dostupná</h2>
        <p role="alert">
          {status === "AUTH_REQUIRED"
            ? "Privilegovaná relácia vypršala. Prihláste sa a dokončite MFA."
            : status === "ACCESS_DENIED"
              ? "Relácia nemá oprávnenie admin.credentials.review."
              : "Dáta sa nepodarilo bezpečne načítať."}
        </p>
      </section>
    );
  if (page === null || page.items.length === 0)
    return (
      <section className="admin-panel">
        <p className="admin-kicker">Kontrola dokladov</p>
        <h2>Žiadne doklady nečakajú</h2>
        <p role="status">Fronta dokladov na schválenie je prázdna.</p>
      </section>
    );

  return (
    <section className="admin-panel admin-credential-review">
      <p className="admin-kicker">Kontrola dokladov</p>
      <h2>Doklady čakajúce na rozhodnutie</h2>
      <p>
        Čakajúce tvrdenia nie sú overené. Schválenie je možné iba po kontrole
        relevantného oprávnenia a jeho súkromných dôkazov.
      </p>
      <div className="admin-profile-review-layout">
        <ul
          className="admin-profile-review-queue"
          aria-label="Čakajúce doklady"
        >
          {page.items.map((item) => (
            <li key={item.claimId}>
              <button
                aria-current={
                  selected?.claimId === item.claimId ? "true" : undefined
                }
                type="button"
                onClick={() => {
                  setSelected(item);
                  setMessage(null);
                }}
              >
                <strong>{profileName(item)}</strong>
                <span>{item.profession.label}</span>
                <span>{item.credentialTypeCode}</span>
              </button>
            </li>
          ))}
        </ul>
        {selected === null ? null : (
          <article className="admin-profile-review-detail">
            <h3>{profileName(selected)}</h3>
            {selected.profile.secondaryName === null ? null : (
              <p>{selected.profile.secondaryName}</p>
            )}
            <p className="profile-authoring-warning" role="status">
              {isVerifiedCredentialState(selected.state)
                ? "Overený doklad."
                : "Čaká na kontrolu — nie je overený."}
            </p>
            <dl>
              <div>
                <dt>Profil</dt>
                <dd>
                  {selected.profile.profileType === "COMPANY"
                    ? "Firma"
                    : "Fyzická osoba"}
                </dd>
              </div>
              <div>
                <dt>Profesia</dt>
                <dd>
                  {selected.profession.label} ({selected.profession.code})
                </dd>
              </div>
              <div>
                <dt>Typ dokladu</dt>
                <dd>{selected.credentialTypeCode}</dd>
              </div>
              <div>
                <dt>Dôkaz</dt>
                <dd>
                  {selected.evidenceRequirement === "REQUIRED"
                    ? "Povinný"
                    : "Voliteľný"}
                </dd>
              </div>
              <div>
                <dt>Platnosť do</dt>
                <dd>{formatExpiry(selected.expiresOn)}</dd>
              </div>
              <div>
                <dt>Podané</dt>
                <dd>{new Date(selected.createdAt).toLocaleString("sk-SK")}</dd>
              </div>
            </dl>
            <h4>Súkromné dôkazy</h4>
            {selected.evidence.length === 0 ? (
              <p>Nie je priložený žiadny dôkaz.</p>
            ) : (
              <ul className="admin-credential-evidence">
                {selected.evidence.map((evidence, index) => {
                  const href = adminCredentialEvidenceHref(
                    selected.claimId,
                    evidence.assetId,
                  );
                  return (
                    <li key={evidence.assetId}>
                      {href === null ? null : (
                        <a href={href} rel="noreferrer" target="_blank">
                          Otvoriť{" "}
                          {evidence.mediaKind === "DOCUMENT"
                            ? "dokument"
                            : "fotografiu"}{" "}
                          {index + 1}
                        </a>
                      )}
                      <span>
                        Priložené{" "}
                        {new Date(evidence.attachedAt).toLocaleString("sk-SK")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <label htmlFor="credential-rejection-category">
              Kategória zamietnutia
            </label>
            <select
              id="credential-rejection-category"
              value={reasonCategory}
              onChange={(event) =>
                setReasonCategory(
                  event.target.value as CredentialRejectionCategory,
                )
              }
            >
              {CREDENTIAL_REJECTION_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {reasonCategoryLabel(category)}
                </option>
              ))}
            </select>
            <label htmlFor="credential-rejection-reason">
              Dôvod zamietnutia pre remeselníka
            </label>
            <textarea
              id="credential-rejection-reason"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              value={reason}
            />
            {message === null ? null : <p role="status">{message}</p>}
            <div className="admin-profile-review-actions">
              <button
                disabled={
                  busy ||
                  (selected.evidenceRequirement === "REQUIRED" &&
                    selected.evidence.length === 0)
                }
                type="button"
                onClick={() => void decide("approve")}
              >
                Schváliť doklad
              </button>
              <button
                disabled={busy || !safeReviewReason(reason.trim())}
                type="button"
                onClick={() => void decide("reject")}
              >
                Zamietnuť tvrdenie
              </button>
            </div>
          </article>
        )}
      </div>
    </section>
  );
}

function parseReviewItem(value: unknown): AdminCredentialReviewItem | null {
  if (
    !exactRecord(value, [
      "claimId",
      "createdAt",
      "credentialTypeCode",
      "evidence",
      "evidenceRequirement",
      "expiresOn",
      "profession",
      "profile",
      "revision",
      "state",
      "updatedAt",
    ]) ||
    !uuid(value.claimId) ||
    !iso(value.createdAt) ||
    !credentialTypeCode(value.credentialTypeCode) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(parseEvidence) ||
    new Set(
      (value.evidence as ReadonlyArray<{ readonly assetId: string }>).map(
        ({ assetId }) => assetId,
      ),
    ).size !== value.evidence.length ||
    (value.evidenceRequirement !== "REQUIRED" &&
      value.evidenceRequirement !== "OPTIONAL") ||
    !(value.expiresOn === null || calendarDate(value.expiresOn)) ||
    !parseProfession(value.profession) ||
    !parseProfile(value.profile) ||
    !positiveRevision(value.revision) ||
    value.state !== "PENDING" ||
    !iso(value.updatedAt)
  )
    return null;
  return Object.freeze(value) as unknown as AdminCredentialReviewItem;
}

function parseEvidence(value: unknown): boolean {
  return (
    exactRecord(value, ["assetId", "attachedAt", "mediaKind"]) &&
    uuid(value.assetId) &&
    iso(value.attachedAt) &&
    (value.mediaKind === "DOCUMENT" || value.mediaKind === "IMAGE")
  );
}

function parseProfession(value: unknown): boolean {
  return (
    exactRecord(value, ["code", "id", "label"]) &&
    professionCode(value.code) &&
    uuid(value.id) &&
    boundedText(value.label, 120)
  );
}

function parseProfile(value: unknown): boolean {
  return (
    exactRecord(value, ["id", "primaryName", "profileType", "secondaryName"]) &&
    uuid(value.id) &&
    (value.primaryName === null || boundedText(value.primaryName, 160)) &&
    (value.profileType === "INDIVIDUAL" || value.profileType === "COMPANY") &&
    (value.secondaryName === null || boundedText(value.secondaryName, 160))
  );
}

function validDecisionResponse(
  value: unknown,
  claimId: string,
  action: CredentialDecisionInput["action"],
): boolean {
  if (
    !exactRecord(value, ["claim", "status"]) ||
    (value.status !== "APPLIED" && value.status !== "DEDUPLICATED") ||
    !exactRecord(value.claim, [
      "claimId",
      "reviewReason",
      "reviewReasonCategory",
      "reviewedAt",
      "revision",
      "state",
    ]) ||
    value.claim.claimId !== claimId ||
    !positiveRevision(value.claim.revision) ||
    !iso(value.claim.reviewedAt)
  )
    return false;
  const expectedState =
    action === "approve"
      ? "APPROVED"
      : action === "reject"
        ? "REJECTED"
        : "REVOKED";
  if (value.claim.state !== expectedState) return false;
  return action === "approve"
    ? value.claim.reviewReason === null &&
        value.claim.reviewReasonCategory === null
    : safeReviewReason(value.claim.reviewReason) &&
        CREDENTIAL_REJECTION_CATEGORIES.includes(
          value.claim.reviewReasonCategory as CredentialRejectionCategory,
        );
}

function profileName(item: AdminCredentialReviewItem): string {
  return (
    item.profile.primaryName ?? item.profile.secondaryName ?? "Profil bez názvu"
  );
}

function formatExpiry(value: string | null): string {
  if (value === null) return "Bez uvedeného dátumu";
  return new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium" }).format(
    new Date(value + "T00:00:00Z"),
  );
}

function reasonCategoryLabel(category: CredentialRejectionCategory): string {
  return {
    EXPIRED_OR_INVALID: "Doklad je neplatný alebo expirovaný",
    FALSE_IDENTITY: "Nesúlad identity",
    FALSE_QUALIFICATION: "Nepravdivá kvalifikácia",
    INSUFFICIENT_EVIDENCE: "Nedostatočný dôkaz",
    MISLEADING_CLAIM: "Zavádzajúce tvrdenie",
    OTHER: "Iný dôvod",
  }[category];
}

function decisionMessage(
  result: Exclude<CredentialDecisionResult, "OK">,
): string {
  if (result === "AUTH_REQUIRED")
    return "Privilegovaná relácia vypršala. Zopakujte MFA.";
  if (result === "ACCESS_DENIED")
    return "Relácia nemá oprávnenie admin.credentials.review.";
  if (result === "NOT_FOUND")
    return "Doklad už nie je dostupný v tejto fronte.";
  if (result === "STALE")
    return "Doklad sa medzitým zmenil. Obnovte frontu a skontrolujte ho znova.";
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

function safeReviewReason(value: unknown): value is string {
  return (
    boundedText(value, 500) &&
    value.length >= 8 &&
    !/(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|www\.|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d)|(?:password|heslo|api[ _-]?key|access[ _-]?token|secret))/iu.test(
      value,
    )
  );
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function credentialTypeCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
  );
}

function professionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}
