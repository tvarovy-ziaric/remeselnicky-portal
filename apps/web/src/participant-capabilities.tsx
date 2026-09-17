"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  loadJobRequestTaxonomySuggestions,
  type JobRequestTaxonomySuggestion,
} from "./job-request-taxonomy-client";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const skillCode = /^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length >= 2 &&
  value.length <= max &&
  !/[\p{Cc}\p{Cf}]|@|https?:\/\/|www\.|\b(?:heslo|password|secret)\b/iu.test(
    value,
  );
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

type Kind = "PROFESSION" | "CANONICAL_SKILL" | "CUSTOM_SKILL";
export interface CapabilityClaim {
  readonly claimId: string;
  readonly participantId: string;
  readonly kind: Kind;
  readonly professionTaxonomyReleaseId: string | null;
  readonly professionCode: string | null;
  readonly skillCatalogReleaseId: string | null;
  readonly skillCode: string | null;
  readonly customSkillText: string | null;
  readonly proposedByUserId: string;
  readonly proposedAt: string;
  readonly confirmedByUserId: string | null;
  readonly confirmedAt: string | null;
  readonly status: "PROPOSED" | "CONFIRMED";
  readonly canConfirm: boolean;
}
export interface CapabilityPage {
  readonly items: readonly CapabilityClaim[];
  readonly canAct: boolean;
  readonly canPropose: boolean;
  readonly nextCursor: {
    readonly proposedAt: string;
    readonly id: string;
  } | null;
}

export function parseCapabilityPage(
  value: unknown,
  participantId: string,
): CapabilityPage | null {
  if (
    !uuid.test(participantId) ||
    !record(value) ||
    !exact(value, ["items", "canAct", "canPropose", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    typeof value.canAct !== "boolean" ||
    typeof value.canPropose !== "boolean" ||
    (value.canPropose && !value.canAct)
  )
    return null;
  const items: CapabilityClaim[] = [];
  const ids = new Set<string>();
  for (const entry of value.items as unknown[]) {
    if (
      !record(entry) ||
      !exact(entry, [
        "claimId",
        "participantId",
        "kind",
        "professionTaxonomyReleaseId",
        "professionCode",
        "skillCatalogReleaseId",
        "skillCode",
        "customSkillText",
        "proposedByUserId",
        "proposedAt",
        "confirmedByUserId",
        "confirmedAt",
        "status",
        "canConfirm",
      ]) ||
      typeof entry.claimId !== "string" ||
      !uuid.test(entry.claimId) ||
      ids.has(entry.claimId) ||
      entry.participantId !== participantId ||
      typeof entry.proposedByUserId !== "string" ||
      !uuid.test(entry.proposedByUserId) ||
      !iso(entry.proposedAt) ||
      (entry.kind !== "PROFESSION" &&
        entry.kind !== "CANONICAL_SKILL" &&
        entry.kind !== "CUSTOM_SKILL") ||
      (entry.status !== "PROPOSED" && entry.status !== "CONFIRMED") ||
      typeof entry.canConfirm !== "boolean" ||
      (entry.canConfirm && (!value.canAct || entry.status !== "PROPOSED")) ||
      (entry.kind === "PROFESSION" &&
        (typeof entry.professionTaxonomyReleaseId !== "string" ||
          !uuid.test(entry.professionTaxonomyReleaseId) ||
          typeof entry.professionCode !== "string" ||
          !professionCode.test(entry.professionCode) ||
          entry.skillCatalogReleaseId !== null ||
          entry.skillCode !== null ||
          entry.customSkillText !== null)) ||
      (entry.kind === "CANONICAL_SKILL" &&
        (entry.professionTaxonomyReleaseId !== null ||
          entry.professionCode !== null ||
          typeof entry.skillCatalogReleaseId !== "string" ||
          !uuid.test(entry.skillCatalogReleaseId) ||
          typeof entry.skillCode !== "string" ||
          !skillCode.test(entry.skillCode) ||
          entry.customSkillText !== null)) ||
      (entry.kind === "CUSTOM_SKILL" &&
        (entry.professionTaxonomyReleaseId !== null ||
          entry.professionCode !== null ||
          entry.skillCatalogReleaseId !== null ||
          entry.skillCode !== null ||
          !safeText(entry.customSkillText, 160))) ||
      (entry.status === "PROPOSED" &&
        (entry.confirmedByUserId !== null || entry.confirmedAt !== null)) ||
      (entry.status === "CONFIRMED" &&
        (typeof entry.confirmedByUserId !== "string" ||
          !uuid.test(entry.confirmedByUserId) ||
          entry.confirmedByUserId === entry.proposedByUserId ||
          !iso(entry.confirmedAt) ||
          Date.parse(entry.confirmedAt) < Date.parse(entry.proposedAt)))
    )
      return null;
    ids.add(entry.claimId);
    items.push(entry as unknown as CapabilityClaim);
  }
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exact(cursor, ["proposedAt", "id"]) ||
      !iso(cursor.proposedAt) ||
      typeof cursor.id !== "string" ||
      !uuid.test(cursor.id) ||
      cursor.id !== items.at(-1)?.claimId ||
      cursor.proposedAt !== items.at(-1)?.proposedAt)
  )
    return null;
  return {
    items,
    canAct: value.canAct,
    canPropose: value.canPropose,
    nextCursor: cursor,
  } as CapabilityPage;
}

export async function loadCapabilityPage(input: {
  fetch: typeof fetch;
  participantId: string;
  cursor?: CapabilityPage["nextCursor"];
}): Promise<
  | { status: "OK"; page: CapabilityPage }
  | { status: "AUTH_REQUIRED" | "UNAVAILABLE" }
> {
  if (!uuid.test(input.participantId)) return { status: "UNAVAILABLE" };
  const query = new URLSearchParams({ limit: "20" });
  if (input.cursor) {
    if (!iso(input.cursor.proposedAt) || !uuid.test(input.cursor.id))
      return { status: "UNAVAILABLE" };
    query.set("beforeAt", input.cursor.proposedAt);
    query.set("beforeId", input.cursor.id);
  }
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/capabilities?${query}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const page = parseCapabilityPage(
      await response.json(),
      input.participantId,
    );
    return page ? { status: "OK", page } : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type CapabilityProposal =
  | { readonly kind: "PROFESSION"; readonly professionCode: string }
  | { readonly kind: "CANONICAL_SKILL"; readonly skillCode: string }
  | { readonly kind: "CUSTOM_SKILL"; readonly customSkillText: string };
export type CapabilityCommandResult = "OK" | "AUTH_REQUIRED" | "UNAVAILABLE";

export function getCapabilityProposalAttempt(
  current: { commandId: string; proposal: CapabilityProposal } | null,
  proposal: CapabilityProposal,
  createId: () => string,
): { commandId: string; proposal: CapabilityProposal } {
  return current ?? { commandId: createId(), proposal };
}

export function getCapabilityConfirmationCommandId(
  attempts: Map<string, string>,
  claimId: string,
  createId: () => string,
): string {
  const existing = attempts.get(claimId);
  if (existing) return existing;
  const commandId = createId();
  attempts.set(claimId, commandId);
  return commandId;
}

async function csrf(fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher.call(globalThis, "/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return record(body) &&
    exact(body, ["csrfToken"]) &&
    typeof body.csrfToken === "string" &&
    body.csrfToken.length > 0 &&
    body.csrfToken.length <= 1000
    ? body.csrfToken
    : null;
}

export async function proposeCapability(input: {
  fetch: typeof fetch;
  participantId: string;
  commandId: string;
  proposal: CapabilityProposal;
}): Promise<CapabilityCommandResult> {
  const { proposal } = input;
  if (
    !uuid.test(input.participantId) ||
    !uuid.test(input.commandId) ||
    (proposal.kind === "PROFESSION" &&
      !professionCode.test(proposal.professionCode)) ||
    (proposal.kind === "CANONICAL_SKILL" &&
      !skillCode.test(proposal.skillCode)) ||
    (proposal.kind === "CUSTOM_SKILL" &&
      !safeText(proposal.customSkillText, 160))
  )
    return "UNAVAILABLE";
  try {
    const token = await csrf(input.fetch);
    if (!token) return "UNAVAILABLE";
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/capabilities`,
      {
        body: JSON.stringify({ commandId: input.commandId, ...proposal }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return "AUTH_REQUIRED";
    if (!response.ok) return "UNAVAILABLE";
    const body: unknown = await response.json();
    return record(body) &&
      exact(body, ["status", "claimId", "claimStatus", "proposedAt"]) &&
      (body.status === "APPLIED" || body.status === "DEDUPLICATED") &&
      typeof body.claimId === "string" &&
      uuid.test(body.claimId) &&
      body.claimStatus === "PROPOSED" &&
      iso(body.proposedAt)
      ? "OK"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

export async function confirmCapability(input: {
  fetch: typeof fetch;
  participantId: string;
  claimId: string;
  commandId: string;
}): Promise<CapabilityCommandResult> {
  if (
    ![input.participantId, input.claimId, input.commandId].every((id) =>
      uuid.test(id),
    )
  )
    return "UNAVAILABLE";
  try {
    const token = await csrf(input.fetch);
    if (!token) return "UNAVAILABLE";
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/capabilities/${input.claimId}/confirm`,
      {
        body: JSON.stringify({ commandId: input.commandId }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return "AUTH_REQUIRED";
    if (!response.ok) return "UNAVAILABLE";
    const body: unknown = await response.json();
    return record(body) &&
      exact(body, ["status", "claimId", "claimStatus", "confirmedAt"]) &&
      (body.status === "APPLIED" || body.status === "DEDUPLICATED") &&
      body.claimId === input.claimId &&
      body.claimStatus === "CONFIRMED" &&
      iso(body.confirmedAt)
      ? "OK"
      : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function claimLabel(claim: CapabilityClaim): string {
  return claim.kind === "PROFESSION"
    ? `Profesia ${claim.professionCode}`
    : claim.kind === "CANONICAL_SKILL"
      ? `Zručnosť ${claim.skillCode}`
      : `Zručnosť ${claim.customSkillText}`;
}

export function CapabilityClaimList({
  page,
  busy,
  onConfirm,
}: {
  page: CapabilityPage;
  busy: boolean;
  onConfirm: (claimId: string) => void;
}) {
  return (
    <ul className="participant-invitation-list">
      {page.items.map((claim) => (
        <li key={claim.claimId}>
          <strong>{claimLabel(claim)}</strong>
          <p>
            {claim.status === "CONFIRMED"
              ? "Potvrdená činnosť na tejto zákazke"
              : "Návrh čaká na potvrdenie druhej strany – zatiaľ nejde o overený dôkaz."}
          </p>
          <p>
            Navrhnuté:{" "}
            <time dateTime={claim.proposedAt}>
              {new Date(claim.proposedAt).toLocaleString("sk-SK")}
            </time>
          </p>
          {claim.confirmedAt && (
            <p>
              Potvrdené:{" "}
              <time dateTime={claim.confirmedAt}>
                {new Date(claim.confirmedAt).toLocaleString("sk-SK")}
              </time>
            </p>
          )}
          {claim.canConfirm && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(claim.claimId)}
            >
              Potvrdiť vykonanú činnosť
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ParticipantCapabilities({
  participantId,
}: {
  participantId: string;
}) {
  const [page, setPage] = useState<CapabilityPage | null>(null);
  const [status, setStatus] = useState<
    "LOADING" | "OK" | "AUTH_REQUIRED" | "UNAVAILABLE"
  >("LOADING");
  const [kind, setKind] = useState<Kind>("PROFESSION");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<
    readonly JobRequestTaxonomySuggestion[]
  >([]);
  const [selected, setSelected] = useState<JobRequestTaxonomySuggestion | null>(
    null,
  );
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposalAttempt = useRef<{
    commandId: string;
    proposal: CapabilityProposal;
  } | null>(null);
  const confirmAttempts = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    setStatus("LOADING");
    setPage(null);
    void loadCapabilityPage({ fetch: globalThis.fetch, participantId }).then(
      (result) => {
        if (!active) return;
        if (result.status === "OK") setPage(result.page);
        setStatus(result.status);
      },
    );
    return () => {
      active = false;
    };
  }, [participantId]);
  useEffect(() => {
    if (
      query.trim().length < 2 ||
      kind === "CUSTOM_SKILL" ||
      proposalAttempt.current
    ) {
      setSuggestions([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void loadJobRequestTaxonomySuggestions(query).then((result) => {
        if (active)
          setSuggestions(
            result.filter((entry) =>
              kind === "PROFESSION"
                ? entry.kind === "PROFESSION"
                : entry.kind === "SKILL",
            ),
          );
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, kind]);
  const refresh = async () => {
    const result = await loadCapabilityPage({
      fetch: globalThis.fetch,
      participantId,
    });
    if (result.status === "OK") {
      setPage(result.page);
      setStatus("OK");
      return true;
    }
    setPage(null);
    setStatus(result.status);
    return false;
  };
  const propose = async () => {
    if (!page?.canPropose || busy) return;
    const proposal: CapabilityProposal | null =
      proposalAttempt.current?.proposal ??
      (kind === "CUSTOM_SKILL"
        ? safeText(custom, 160)
          ? { kind, customSkillText: custom }
          : null
        : selected &&
            (kind === "PROFESSION"
              ? selected.kind === "PROFESSION" &&
                professionCode.test(selected.code)
              : selected.kind === "SKILL" && skillCode.test(selected.code))
          ? kind === "PROFESSION"
            ? { kind, professionCode: selected.code }
            : { kind, skillCode: selected.code }
          : null);
    if (!proposal) {
      setError("Vyberte platnú profesiu alebo zručnosť.");
      return;
    }
    const attempt = getCapabilityProposalAttempt(
      proposalAttempt.current,
      proposal,
      () => crypto.randomUUID(),
    );
    proposalAttempt.current = attempt;
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await proposeCapability({
      fetch: globalThis.fetch,
      participantId,
      commandId: attempt.commandId,
      proposal: attempt.proposal,
    });
    if (result === "OK") {
      proposalAttempt.current = null;
      setSelected(null);
      setQuery("");
      setCustom("");
      setMessage(
        "Návrh bol uložený. Overený bude až po potvrdení druhou stranou.",
      );
      if (!(await refresh()))
        setError(
          "Návrh sa potvrdil, ale zoznam sa nepodarilo obnoviť. Obnovte stránku.",
        );
    } else
      setError(
        result === "AUTH_REQUIRED"
          ? "Prihlásenie vypršalo. Prihláste sa a zopakujte uložený návrh."
          : "Výsledok návrhu sa nepodarilo overiť. Zopakujte ten istý návrh alebo obnovte stránku.",
      );
    setBusy(false);
  };
  const confirm = async (claimId: string) => {
    const claim = page?.items.find((item) => item.claimId === claimId);
    if (!claim?.canConfirm || busy) return;
    const commandId = getCapabilityConfirmationCommandId(
      confirmAttempts.current,
      claimId,
      () => crypto.randomUUID(),
    );
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await confirmCapability({
      fetch: globalThis.fetch,
      participantId,
      claimId,
      commandId,
    });
    if (result === "OK") {
      confirmAttempts.current.delete(claimId);
      setMessage(
        "Činnosť na zákazke bola potvrdená. Úroveň odbornosti sa tým automaticky nemení.",
      );
      if (!(await refresh()))
        setError(
          "Potvrdenie prešlo, ale zoznam sa nepodarilo obnoviť. Obnovte stránku.",
        );
    } else
      setError(
        result === "AUTH_REQUIRED"
          ? "Prihlásenie vypršalo. Prihláste sa a skúste potvrdenie znova."
          : "Výsledok potvrdenia sa nepodarilo overiť. Skúste potvrdenie znova.",
      );
    setBusy(false);
  };
  const more = async () => {
    if (!page?.nextCursor || busy || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const result = await loadCapabilityPage({
      fetch: globalThis.fetch,
      participantId,
      cursor: page.nextCursor,
    });
    if (
      result.status !== "OK" ||
      result.page.canAct !== page.canAct ||
      result.page.canPropose !== page.canPropose ||
      result.page.items.some((item) =>
        page.items.some((old) => old.claimId === item.claimId),
      )
    )
      setError("Ďalšie záznamy sa nepodarilo bezpečne načítať.");
    else
      setPage({
        ...page,
        items: [...page.items, ...result.page.items],
        nextCursor: result.page.nextCursor,
      });
    setLoadingMore(false);
  };
  if (status === "LOADING")
    return <p role="status">Načítavam profesie a zručnosti účastníka…</p>;
  if (status !== "OK" || !page)
    return (
      <p role="alert">
        {status === "AUTH_REQUIRED"
          ? "Na zobrazenie sa prihláste."
          : "Záznamy sa nepodarilo načítať alebo k nim nemáte prístup."}
      </p>
    );
  return (
    <section aria-label="Profesie a zručnosti na zákazke">
      <p>
        Potvrdenie platí pre činnosť na tejto zákazke. Neudeľuje automaticky
        vyššiu úroveň odbornosti.
      </p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {page.canPropose && (
        <div className="job-roster-role-controls">
          <h2>Navrhnúť vykonanú činnosť</h2>
          <label htmlFor="capability-kind">Typ</label>
          <select
            id="capability-kind"
            value={kind}
            disabled={busy || !!proposalAttempt.current}
            onChange={(event) => {
              setKind(event.target.value as Kind);
              setSelected(null);
              setQuery("");
            }}
          >
            <option value="PROFESSION">Profesia</option>
            <option value="CANONICAL_SKILL">Zručnosť z katalógu</option>
            <option value="CUSTOM_SKILL">Vlastná zručnosť</option>
          </select>
          {kind === "CUSTOM_SKILL" ? (
            <>
              <label htmlFor="capability-custom">Zručnosť</label>
              <input
                id="capability-custom"
                maxLength={160}
                value={
                  proposalAttempt.current?.proposal.kind === "CUSTOM_SKILL"
                    ? proposalAttempt.current.proposal.customSkillText
                    : custom
                }
                disabled={busy || !!proposalAttempt.current}
                onChange={(event) => setCustom(event.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor="capability-search">
                Vyhľadať {kind === "PROFESSION" ? "profesiu" : "zručnosť"}
              </label>
              <input
                id="capability-search"
                value={query}
                disabled={busy || !!proposalAttempt.current}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(null);
                }}
              />
              {selected && <p>Vybrané: {selected.label}</p>}
              {suggestions.length > 0 && (
                <ul>
                  {suggestions.map((item) => (
                    <li key={item.code}>
                      <button
                        type="button"
                        disabled={busy || !!proposalAttempt.current}
                        onClick={() => setSelected(item)}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <button
            type="button"
            disabled={
              busy ||
              (!proposalAttempt.current &&
                (kind === "CUSTOM_SKILL" ? !safeText(custom, 160) : !selected))
            }
            onClick={() => void propose()}
          >
            {busy
              ? "Ukladám…"
              : proposalAttempt.current
                ? "Zopakovať uložený návrh"
                : "Odoslať návrh druhej strane"}
          </button>
        </div>
      )}
      <h2>Záznamy</h2>
      {page.items.length === 0 ? (
        <p>Zatiaľ tu nie sú navrhnuté činnosti.</p>
      ) : (
        <CapabilityClaimList
          page={page}
          busy={busy}
          onConfirm={(id) => void confirm(id)}
        />
      )}
      {page.nextCursor && (
        <button
          type="button"
          disabled={busy || loadingMore}
          onClick={() => void more()}
        >
          {loadingMore ? "Načítavam…" : "Načítať ďalšie záznamy"}
        </button>
      )}
    </section>
  );
}
