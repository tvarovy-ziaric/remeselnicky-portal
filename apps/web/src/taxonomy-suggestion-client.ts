export type TaxonomySuggestionKind = "PROFESSION" | "SERVICE";

export interface OwnedTaxonomySuggestion {
  readonly adminDecisionNote: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly id: string;
  readonly proposedDescription: string;
  readonly proposedName: string;
  readonly resolvedTaxonomyCode: string | null;
  readonly resolvedTaxonomyLabel: string | null;
  readonly revision: number;
  readonly state:
    "PENDING" | "APPROVED_AS_NEW" | "MAPPED_TO_EXISTING" | "REJECTED";
  readonly suggestedKind: TaxonomySuggestionKind | null;
}

export type SubmitTaxonomySuggestionResult =
  | Readonly<{
      status: "APPLIED";
      suggestion: OwnedTaxonomySuggestion;
    }>
  | Readonly<{
      status:
        | "DENIED"
        | "DUPLICATE_PENDING"
        | "INVALID_REQUEST"
        | "PROFILE_UNAVAILABLE"
        | "UNAVAILABLE";
    }>;

export interface TaxonomySuggestionClient {
  load(
    suggestionId: string,
  ): Promise<
    | Readonly<{ status: "READY"; suggestion: OwnedTaxonomySuggestion }>
    | Readonly<{ status: "DENIED" | "NOT_FOUND" | "UNAVAILABLE" }>
  >;
  submit(input: {
    commandId: string;
    profileId: string;
    proposedDescription: string;
    proposedName: string;
    suggestedKind: TaxonomySuggestionKind | null;
    suggestionId: string;
  }): Promise<SubmitTaxonomySuggestionResult>;
}

export function createTaxonomySuggestionClient(
  fetcher: typeof fetch = fetch,
): TaxonomySuggestionClient {
  return Object.freeze({
    async load(suggestionId: string) {
      if (!uuid(suggestionId)) return { status: "NOT_FOUND" } as const;
      try {
        const response = await fetcher(
          "/v1/me/taxonomy-suggestions/" + encodeURIComponent(suggestionId),
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          },
        );
        if (response.status === 401 || response.status === 403)
          return { status: "DENIED" } as const;
        if (response.status === 404) return { status: "NOT_FOUND" } as const;
        if (!response.ok) return { status: "UNAVAILABLE" } as const;
        const body: unknown = await response.json();
        if (!exactRecord(body, ["suggestion"]))
          return { status: "UNAVAILABLE" } as const;
        const suggestion = parseOwnedTaxonomySuggestion(body.suggestion);
        return suggestion === null
          ? ({ status: "UNAVAILABLE" } as const)
          : ({ status: "READY", suggestion } as const);
      } catch {
        return { status: "UNAVAILABLE" } as const;
      }
    },
    async submit(
      input: Parameters<TaxonomySuggestionClient["submit"]>[0],
    ): Promise<SubmitTaxonomySuggestionResult> {
      try {
        const csrfToken = await loadCsrf(fetcher);
        if (csrfToken === null) return { status: "UNAVAILABLE" };
        const response = await fetcher(
          "/v1/me/craftsman-profiles/" +
            encodeURIComponent(input.profileId) +
            "/taxonomy-suggestions",
          {
            body: JSON.stringify({
              commandId: input.commandId,
              proposedDescription: input.proposedDescription,
              proposedName: input.proposedName,
              suggestedKind: input.suggestedKind,
              suggestionId: input.suggestionId,
            }),
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "x-csrf-token": csrfToken,
            },
            method: "POST",
          },
        );
        const body: unknown = await response.json();
        if (response.ok) {
          const suggestion = parseOwnedTaxonomySuggestionResponse(body);
          return suggestion === null
            ? { status: "UNAVAILABLE" }
            : { status: "APPLIED", suggestion };
        }
        const code = errorCode(body);
        if (response.status === 401 || response.status === 403)
          return { status: "DENIED" };
        if (response.status === 404) return { status: "PROFILE_UNAVAILABLE" };
        if (response.status === 400) return { status: "INVALID_REQUEST" };
        if (response.status === 409 && code === "DUPLICATE_PENDING")
          return { status: "DUPLICATE_PENDING" };
        return { status: "UNAVAILABLE" };
      } catch {
        return { status: "UNAVAILABLE" };
      }
    },
  });
}

export function parseOwnedTaxonomySuggestionResponse(
  value: unknown,
): OwnedTaxonomySuggestion | null {
  if (!exactRecord(value, ["status", "suggestion"])) return null;
  if (!["APPLIED", "DEDUPLICATED"].includes(String(value.status))) return null;
  return parseOwnedTaxonomySuggestion(value.suggestion);
}

export function parseOwnedTaxonomySuggestion(
  item: unknown,
): OwnedTaxonomySuggestion | null {
  if (
    !exactRecord(item, [
      "adminDecisionNote",
      "createdAt",
      "decidedAt",
      "id",
      "proposedDescription",
      "proposedName",
      "resolvedTaxonomyCode",
      "resolvedTaxonomyLabel",
      "revision",
      "state",
      "suggestedKind",
    ]) ||
    !uuid(item.id) ||
    !boundedText(item.proposedName, 100) ||
    !boundedText(item.proposedDescription, 1_000) ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 1 ||
    !["PENDING", "APPROVED_AS_NEW", "MAPPED_TO_EXISTING", "REJECTED"].includes(
      String(item.state),
    ) ||
    !(
      item.suggestedKind === null ||
      item.suggestedKind === "PROFESSION" ||
      item.suggestedKind === "SERVICE"
    ) ||
    !(
      item.adminDecisionNote === null ||
      boundedText(item.adminDecisionNote, 500)
    ) ||
    !(
      item.resolvedTaxonomyCode === null || safeCode(item.resolvedTaxonomyCode)
    ) ||
    !(
      item.resolvedTaxonomyLabel === null ||
      (boundedText(item.resolvedTaxonomyLabel, 120) &&
        item.resolvedTaxonomyLabel.length >= 2)
    ) ||
    !isoDate(item.createdAt) ||
    !(item.decidedAt === null || isoDate(item.decidedAt))
  )
    return null;
  return Object.freeze(item) as unknown as OwnedTaxonomySuggestion;
}

async function loadCsrf(fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher("/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return exactRecord(body, ["csrfToken"]) &&
    typeof body.csrfToken === "string" &&
    body.csrfToken.length >= 1 &&
    body.csrfToken.length <= 1_000 &&
    !/\p{Cc}/u.test(body.csrfToken)
    ? body.csrfToken
    : null;
}

function errorCode(value: unknown): string {
  return record(value) && typeof value.code === "string" ? value.code : "";
}
function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value.replaceAll("\n", ""))
  );
}
function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_.:-]{1,95}$/u.test(value);
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
