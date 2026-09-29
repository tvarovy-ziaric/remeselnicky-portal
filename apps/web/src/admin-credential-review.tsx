"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import { Notice, PageHeader } from "./design-system";

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

export const ADMIN_CREDENTIAL_HISTORY_STATES = Object.freeze([
  "APPROVED",
  "REJECTED",
  "REVOKED",
] as const);

export type AdminCredentialHistoryState =
  (typeof ADMIN_CREDENTIAL_HISTORY_STATES)[number];

export type AdminCredentialReviewView = "PENDING" | AdminCredentialHistoryState;

export interface AdminCredentialReviewHistoryItem extends Omit<
  AdminCredentialReviewItem,
  "state"
> {
  readonly reviewReasonCategory: CredentialRejectionCategory | null;
  readonly reviewReason: string | null;
  readonly reviewedAt: string;
  readonly state: AdminCredentialHistoryState;
}

export interface AdminCredentialReviewHistoryPage {
  readonly items: readonly AdminCredentialReviewHistoryItem[];
  readonly nextCursor: string | null;
}

export type AdminCredentialReviewListItem =
  AdminCredentialReviewItem | AdminCredentialReviewHistoryItem;

export interface AdminCredentialReviewListPage {
  readonly items: readonly AdminCredentialReviewListItem[];
  readonly nextCursor: string | null;
}

type LoadResult =
  | { readonly page: AdminCredentialReviewListPage; readonly status: "OK" }
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
const historyPath = "/v1/admin/credential-claims/review-history";

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

export async function loadAdminCredentialReviewHistory(
  state: AdminCredentialHistoryState,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<LoadResult> {
  if (
    !ADMIN_CREDENTIAL_HISTORY_STATES.includes(state) ||
    (cursor !== undefined && !uuid(cursor))
  )
    return { status: "UNAVAILABLE" };
  const query = new URLSearchParams({ state, limit: "20" });
  if (cursor !== undefined) query.set("cursor", cursor);
  try {
    const response = await fetcher(historyPath + "?" + query.toString(), {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 403) return { status: "ACCESS_DENIED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseAdminCredentialReviewHistoryPage(
      await response.json(),
      state,
    );
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

export function parseAdminCredentialReviewHistoryPage(
  value: unknown,
  expectedState: AdminCredentialHistoryState,
): AdminCredentialReviewHistoryPage | null {
  if (
    !ADMIN_CREDENTIAL_HISTORY_STATES.includes(expectedState) ||
    !exactRecord(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || uuid(value.nextCursor))
  )
    return null;
  const items = value.items.map((item) =>
    parseHistoryItem(item, expectedState),
  );
  if (items.some((item) => item === null)) return null;
  const parsed = items as AdminCredentialReviewHistoryItem[];
  if (new Set(parsed.map(({ claimId }) => claimId)).size !== parsed.length)
    return null;
  return Object.freeze({
    items: Object.freeze(parsed),
    nextCursor: value.nextCursor,
  });
}

export function appendAdminCredentialReviewPage(
  current: AdminCredentialReviewListPage,
  next: AdminCredentialReviewListPage,
  view: AdminCredentialReviewView,
): AdminCredentialReviewListPage | null {
  const items = [...current.items, ...next.items];
  if (
    !items.every((item) => item.state === view) ||
    new Set(items.map(({ claimId }) => claimId)).size !== items.length
  )
    return null;
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: next.nextCursor,
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

export function credentialDecisionCommandId(
  attempts: Map<string, string>,
  claimId: string,
  action: CredentialDecisionInput["action"],
  generate: () => string = () => crypto.randomUUID(),
): string {
  const key = claimId + ":" + action;
  const existing = attempts.get(key);
  if (existing !== undefined) return existing;
  const created = generate();
  attempts.set(key, created);
  return created;
}

export function settleCredentialDecisionAttempt(
  attempts: Map<string, string>,
  claimId: string,
  action: CredentialDecisionInput["action"],
  result: CredentialDecisionResult,
): void {
  if (result !== "UNAVAILABLE") attempts.delete(claimId + ":" + action);
}

export function AdminCredentialReviewWorkspace() {
  const [view, setView] = useState<AdminCredentialReviewView>("PENDING");
  const [page, setPage] = useState<AdminCredentialReviewListPage | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "ACCESS_DENIED" | "UNAVAILABLE"
  >("LOADING");
  const [selected, setSelected] =
    useState<AdminCredentialReviewListItem | null>(null);
  const [reasonCategory, setReasonCategory] =
    useState<CredentialRejectionCategory>("INSUFFICIENT_EVIDENCE");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempts = useRef(new Map<string, string>());
  const loadVersion = useRef(0);

  const load = useCallback(async (targetView: AdminCredentialReviewView) => {
    const version = ++loadVersion.current;
    setLoadingMore(false);
    setStatus("LOADING");
    const result =
      targetView === "PENDING"
        ? await loadAdminCredentialReviewQueue()
        : await loadAdminCredentialReviewHistory(targetView);
    if (version !== loadVersion.current) return;
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
    setPage(null);
    setSelected(null);
    setReason("");
    setReasonCategory("INSUFFICIENT_EVIDENCE");
    setMessage(null);
    setLoadingMore(false);
    void load(view);
  }, [load, view]);

  const loadMore = async () => {
    if (page === null || page.nextCursor === null || loadingMore || busy)
      return;
    const version = loadVersion.current;
    const cursor = page.nextCursor;
    setLoadingMore(true);
    const result =
      view === "PENDING"
        ? await loadAdminCredentialReviewQueue(cursor)
        : await loadAdminCredentialReviewHistory(view, cursor);
    if (version !== loadVersion.current) return;
    if (result.status === "OK") {
      const appended = appendAdminCredentialReviewPage(page, result.page, view);
      if (appended === null)
        setMessage("Ďalšiu stranu sa nepodarilo bezpečne pripojiť.");
      else setPage(appended);
    } else if (
      result.status === "AUTH_REQUIRED" ||
      result.status === "ACCESS_DENIED"
    ) {
      setPage(null);
      setSelected(null);
      setStatus(result.status);
    } else {
      setMessage("Ďalšiu stranu sa nepodarilo bezpečne načítať.");
    }
    setLoadingMore(false);
  };

  const decide = async (action: "approve" | "reject" | "revoke") => {
    if (
      selected === null ||
      busy ||
      (action === "revoke"
        ? selected.state !== "APPROVED"
        : selected.state !== "PENDING")
    )
      return;
    if (
      action === "approve" &&
      selected.evidenceRequirement === "REQUIRED" &&
      selected.evidence.length === 0
    ) {
      setMessage("Povinný doklad nemožno schváliť bez priloženého dôkazu.");
      return;
    }
    const normalizedReason = reason.trim().replace(/\s+/gu, " ");
    if (action !== "approve" && !safeReviewReason(normalizedReason)) {
      setMessage(
        action === "revoke"
          ? "Pri odobratí zadajte bezpečný a zrozumiteľný dôvod."
          : "Pri zamietnutí zadajte bezpečný a zrozumiteľný dôvod.",
      );
      return;
    }
    const commandId = credentialDecisionCommandId(
      attempts.current,
      selected.claimId,
      action,
    );
    setBusy(true);
    setMessage(null);
    const result = await decideAdminCredentialClaim({
      action,
      claimId: selected.claimId,
      commandId,
      expectedRevision: selected.revision,
      ...(action !== "approve"
        ? { reason: normalizedReason, reasonCategory }
        : {}),
    });
    settleCredentialDecisionAttempt(
      attempts.current,
      selected.claimId,
      action,
      result,
    );
    if (result === "OK") {
      setReason("");
      setMessage(
        action === "approve"
          ? "Doklad bol schválený. Až teraz je overený."
          : action === "reject"
            ? "Tvrdenie o doklade bolo zamietnuté."
            : "Overenie dokladu bolo odobraté.",
      );
      await load(view);
    } else {
      setMessage(decisionMessage(result));
    }
    setBusy(false);
  };

  const views = Object.freeze([
    ["PENDING", "Čakajúce"],
    ["APPROVED", "Schválené"],
    ["REJECTED", "Zamietnuté"],
    ["REVOKED", "Odobraté"],
  ] as const);

  return (
    <section className="admin-panel admin-credential-review">
      <PageHeader
        eyebrow="Kontrola dokladov"
        lead={
          <p>
            Podklad je súkromný. Každé schválenie, zamietnutie aj odobratie
            zostáva v histórii.
          </p>
        }
        title="Doklady a história rozhodnutí"
      />
      <Notice title="Čakajúci doklad nie je overený" tone="warning">
        <p>
          Schválenie je možné až po kontrole relevantného podkladu; pri
          zamietnutí alebo odobratí je povinný konkrétny dôvod.
        </p>
      </Notice>
      <nav
        aria-label="Pohľady kontroly dokladov"
        className="admin-credential-review-tabs"
      >
        {views.map(([state, label]) => (
          <button
            aria-pressed={view === state}
            disabled={busy}
            key={state}
            type="button"
            onClick={() => setView(state)}
          >
            {label}
          </button>
        ))}
      </nav>
      {status === "LOADING" ? (
        <p role="status">Načítavam doklady na kontrolu…</p>
      ) : status !== "OK" ? (
        <div>
          <h3>Pohľad nie je dostupný</h3>
          <p role="alert">
            {status === "AUTH_REQUIRED"
              ? "Privilegovaná relácia vypršala. Prihláste sa a dokončite MFA."
              : status === "ACCESS_DENIED"
                ? "Relácia nemá oprávnenie admin.credentials.review."
                : "Dáta sa nepodarilo bezpečne načítať."}
          </p>
        </div>
      ) : page === null || page.items.length === 0 ? (
        <p role="status">{emptyViewMessage(view)}</p>
      ) : (
        <div className="admin-profile-review-layout">
          <div>
            <ul
              className="admin-profile-review-queue"
              aria-label={viewQueueLabel(view)}
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
                      setReason("");
                      setReasonCategory("INSUFFICIENT_EVIDENCE");
                      setMessage(null);
                    }}
                  >
                    <strong>{profileName(item)}</strong>
                    <span>{item.profession.label}</span>
                    <span>
                      {humanizeCredentialType(item.credentialTypeCode)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {page.nextCursor === null ? null : (
              <button
                className="admin-credential-review-load-more"
                disabled={busy || loadingMore}
                type="button"
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Načítavam…" : "Načítať ďalšie"}
              </button>
            )}
          </div>
          {selected === null ? null : (
            <AdminCredentialReviewDetail
              busy={busy}
              item={selected}
              message={message}
              reason={reason}
              reasonCategory={reasonCategory}
              onDecision={(action) => void decide(action)}
              onReasonChange={setReason}
              onReasonCategoryChange={setReasonCategory}
            />
          )}
        </div>
      )}
    </section>
  );
}

export function AdminCredentialReviewDetail({
  busy,
  item,
  message,
  onDecision,
  onReasonCategoryChange,
  onReasonChange,
  reason,
  reasonCategory,
}: Readonly<{
  busy: boolean;
  item: AdminCredentialReviewListItem;
  message: string | null;
  onDecision: (action: "approve" | "reject" | "revoke") => void;
  onReasonCategoryChange: (category: CredentialRejectionCategory) => void;
  onReasonChange: (reason: string) => void;
  reason: string;
  reasonCategory: CredentialRejectionCategory;
}>) {
  const isPending = item.state === "PENDING";
  const isApproved = item.state === "APPROVED";
  const canOpenEvidence = isPending || isApproved;
  const needsDecisionReason = isPending || isApproved;
  return (
    <article className="admin-profile-review-detail">
      <h3>{profileName(item)}</h3>
      {item.profile.secondaryName === null ? null : (
        <p>{item.profile.secondaryName}</p>
      )}
      <p className="profile-authoring-warning" role="status">
        {credentialStateMessage(item.state)}
      </p>
      <dl>
        <div>
          <dt>Profil</dt>
          <dd>
            {item.profile.profileType === "COMPANY" ? "Firma" : "Fyzická osoba"}
          </dd>
        </div>
        <div>
          <dt>Profesia</dt>
          <dd>{item.profession.label}</dd>
        </div>
        <div>
          <dt>Typ dokladu</dt>
          <dd>{humanizeCredentialType(item.credentialTypeCode)}</dd>
        </div>
        <div>
          <dt>Dôkaz</dt>
          <dd>
            {item.evidenceRequirement === "REQUIRED" ? "Povinný" : "Voliteľný"}
          </dd>
        </div>
        <div>
          <dt>Platnosť do</dt>
          <dd>{formatExpiry(item.expiresOn)}</dd>
        </div>
        <div>
          <dt>Podané</dt>
          <dd>{new Date(item.createdAt).toLocaleString("sk-SK")}</dd>
        </div>
        {item.state === "PENDING" ? null : (
          <div>
            <dt>Rozhodnuté</dt>
            <dd>{new Date(item.reviewedAt).toLocaleString("sk-SK")}</dd>
          </div>
        )}
      </dl>
      {item.state === "REJECTED" || item.state === "REVOKED" ? (
        <div className="admin-credential-review-reason">
          <h4>
            {item.state === "REJECTED"
              ? "Dôvod zamietnutia"
              : "Dôvod odobratia"}
          </h4>
          <p>
            {item.reviewReasonCategory === null
              ? "Dôvod nie je dostupný"
              : reasonCategoryLabel(item.reviewReasonCategory)}
          </p>
          <p>{item.reviewReason}</p>
        </div>
      ) : null}
      <h4>Súkromné dôkazy</h4>
      {item.evidence.length === 0 ? (
        <p>Nie je priložený žiadny dôkaz.</p>
      ) : canOpenEvidence ? (
        <ul className="admin-credential-evidence">
          {item.evidence.map((evidence, index) => {
            const href = adminCredentialEvidenceHref(
              item.claimId,
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
      ) : (
        <p>Dôkazy uzavretého rozhodnutia sa v tomto pohľade neotvárajú.</p>
      )}
      {needsDecisionReason ? (
        <>
          <label htmlFor="credential-rejection-category">
            {isApproved ? "Kategória odobratia" : "Kategória zamietnutia"}
          </label>
          <select
            id="credential-rejection-category"
            value={reasonCategory}
            onChange={(event) =>
              onReasonCategoryChange(
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
            {isApproved
              ? "Dôvod odobratia pre remeselníka"
              : "Dôvod zamietnutia pre remeselníka"}
          </label>
          <textarea
            id="credential-rejection-reason"
            maxLength={500}
            onChange={(event) => onReasonChange(event.target.value)}
            rows={4}
            value={reason}
          />
        </>
      ) : null}
      {message === null ? null : <p role="status">{message}</p>}
      {isPending ? (
        <div className="admin-profile-review-actions">
          <button
            disabled={
              busy ||
              (item.evidenceRequirement === "REQUIRED" &&
                item.evidence.length === 0)
            }
            type="button"
            onClick={() => onDecision("approve")}
          >
            Schváliť doklad
          </button>
          <button
            disabled={busy || !safeReviewReason(reason.trim())}
            type="button"
            onClick={() => onDecision("reject")}
          >
            Zamietnuť tvrdenie
          </button>
        </div>
      ) : isApproved ? (
        <div className="admin-profile-review-actions">
          <button
            disabled={busy || !safeReviewReason(reason.trim())}
            type="button"
            onClick={() => onDecision("revoke")}
          >
            Odobrať overenie
          </button>
        </div>
      ) : null}
    </article>
  );
}

function emptyViewMessage(view: AdminCredentialReviewView): string {
  return {
    APPROVED: "Nie sú dostupné žiadne schválené doklady.",
    PENDING: "Fronta dokladov na schválenie je prázdna.",
    REJECTED: "Nie sú dostupné žiadne zamietnuté doklady.",
    REVOKED: "Nie sú dostupné žiadne odobraté overenia.",
  }[view];
}

function viewQueueLabel(view: AdminCredentialReviewView): string {
  return {
    APPROVED: "Schválené doklady",
    PENDING: "Čakajúce doklady",
    REJECTED: "Zamietnuté doklady",
    REVOKED: "Odobraté overenia",
  }[view];
}

function credentialStateMessage(view: AdminCredentialReviewView): string {
  return {
    APPROVED: "Overený doklad.",
    PENDING: "Čaká na kontrolu — nie je overený.",
    REJECTED: "Zamietnutý doklad — nie je overený.",
    REVOKED: "Overenie bolo odobraté — doklad nie je overený.",
  }[view];
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

function parseHistoryItem(
  value: unknown,
  expectedState: AdminCredentialHistoryState,
): AdminCredentialReviewHistoryItem | null {
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
      "reviewReasonCategory",
      "reviewReason",
      "reviewedAt",
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
    value.state !== expectedState ||
    !iso(value.reviewedAt) ||
    !iso(value.updatedAt)
  )
    return null;
  if (expectedState === "APPROVED") {
    if (value.reviewReason !== null || value.reviewReasonCategory !== null)
      return null;
  } else if (
    !safeReviewReason(value.reviewReason) ||
    !CREDENTIAL_REJECTION_CATEGORIES.includes(
      value.reviewReasonCategory as CredentialRejectionCategory,
    )
  ) {
    return null;
  }
  return Object.freeze(value) as unknown as AdminCredentialReviewHistoryItem;
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

function profileName(item: AdminCredentialReviewListItem): string {
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

function humanizeCredentialType(value: string): string {
  const segment = value.split(/[.:/]/u).at(-1) ?? value;
  const words = segment.replace(/[_-]+/gu, " ").toLocaleLowerCase("sk-SK");
  return words.length === 0
    ? "Typ dokladu spravovaný platformou"
    : `${words.charAt(0).toLocaleUpperCase("sk-SK")}${words.slice(1)}`;
}

function professionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}
