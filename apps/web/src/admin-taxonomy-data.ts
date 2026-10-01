export type AdminTaxonomyKind = "PROFESSION" | "SERVICE";
export type AdminTaxonomyState = "ACTIVE" | "DEPRECATED";

export interface AdminTaxonomyItem {
  readonly aliases: readonly string[];
  readonly code: string;
  readonly description: string | null;
  readonly kind: AdminTaxonomyKind;
  readonly name: string;
  readonly primaryProfessionCode: string | null;
  readonly professionCodes: readonly string[];
  readonly releaseVersion: number;
  readonly replacedByCode: string | null;
  readonly slug: string;
  readonly state: AdminTaxonomyState;
}

export interface AdminTaxonomySuggestion {
  readonly adminDecisionNote: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly id: string;
  readonly proposedDescription: string;
  readonly proposedName: string;
  readonly requesterCraftsmanProfileId: string;
  readonly resolvedTaxonomyCode: string | null;
  readonly resolvedTaxonomyLabel: string | null;
  readonly revision: number;
  readonly state:
    "PENDING" | "APPROVED_AS_NEW" | "MAPPED_TO_EXISTING" | "REJECTED";
  readonly suggestedKind: AdminTaxonomyKind | null;
}

export type AdminTaxonomyLoadResult<T> =
  | { readonly data: T; readonly status: "OK" }
  | {
      readonly status: "AUTH_REQUIRED" | "DENIED" | "UNAVAILABLE";
    };

export type AdminTaxonomyMutationResult =
  | { readonly status: "OK" }
  | {
      readonly conflicts: readonly string[];
      readonly status: "ALIAS_CONFLICT";
    }
  | {
      readonly code: string;
      readonly status: "AUTH_REQUIRED" | "CONFLICT" | "DENIED" | "UNAVAILABLE";
    };

export function buildAdminTaxonomyMapPayload(input: {
  readonly addProposedNameAsAlias: boolean;
  readonly adminDecisionNote: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly resolvedKind: AdminTaxonomyKind;
  readonly resolvedTaxonomyCode: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    addProposedNameAsAlias: input.addProposedNameAsAlias,
    adminDecisionNote: input.adminDecisionNote,
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    resolvedKind: input.resolvedKind,
    resolvedTaxonomyCode: input.resolvedTaxonomyCode,
  });
}

export async function loadAdminTaxonomyCatalog(
  input: {
    readonly kind?: AdminTaxonomyKind;
    readonly query?: string;
    readonly state?: AdminTaxonomyState;
  } = {},
  fetcher: typeof fetch = fetch,
): Promise<AdminTaxonomyLoadResult<readonly AdminTaxonomyItem[]>> {
  const query = new URLSearchParams({ limit: "300" });
  if (input.kind !== undefined) query.set("kind", input.kind);
  if (input.state !== undefined) query.set("state", input.state);
  if (input.query !== undefined && input.query.trim().length > 0) {
    query.set("query", input.query.trim());
  }
  return loadItems("/v1/admin/taxonomy/catalog?" + query.toString(), fetcher);
}

export async function loadSimilarAdminTaxonomyItems(
  proposedName: string,
  kind: AdminTaxonomyKind | null,
  fetcher: typeof fetch = fetch,
): Promise<AdminTaxonomyLoadResult<readonly AdminTaxonomyItem[]>> {
  const query = new URLSearchParams({ limit: "8", query: proposedName.trim() });
  if (kind !== null) query.set("kind", kind);
  return loadItems(
    "/v1/admin/taxonomy/catalog-similar?" + query.toString(),
    fetcher,
  );
}

export async function loadAdminTaxonomySuggestionQueue(
  fetcher: typeof fetch = fetch,
): Promise<AdminTaxonomyLoadResult<readonly AdminTaxonomySuggestion[]>> {
  try {
    const response = await fetcher(
      "/v1/admin/taxonomy-suggestions/review-queue?limit=100",
      readOptions(),
    );
    const denied = statusResult(response.status);
    if (denied !== null) return denied;
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (!exact(body, ["items"]) || !Array.isArray(body.items)) {
      return { status: "UNAVAILABLE" };
    }
    const items = body.items.map(parseSuggestion);
    if (items.some((item) => item === null)) {
      return { status: "UNAVAILABLE" };
    }
    return {
      data: Object.freeze(items as AdminTaxonomySuggestion[]),
      status: "OK",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function mutateAdminTaxonomy(
  path: string,
  payload: Readonly<Record<string, unknown>>,
  fetcher: typeof fetch = fetch,
): Promise<AdminTaxonomyMutationResult> {
  if (!path.startsWith("/v1/admin/taxonomy")) {
    return { code: "INVALID_PATH", status: "UNAVAILABLE" };
  }
  try {
    const token = await csrf(fetcher);
    if (token.status !== "OK") return token;
    const response = await fetcher(path, {
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": token.token,
      },
      method: "POST",
    });
    if (response.status === 401)
      return { code: "AUTHENTICATION_REQUIRED", status: "AUTH_REQUIRED" };
    if (response.status === 403)
      return { code: "PRIVILEGED_ACCESS_DENIED", status: "DENIED" };
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 409) {
      if (
        exact(body, ["aliasConflicts", "status"]) &&
        body.status === "ALIAS_CONFLICT" &&
        Array.isArray(body.aliasConflicts)
      ) {
        const conflicts = body.aliasConflicts.flatMap((value) => {
          if (
            !exact(value, [
              "alias",
              "conflictingCode",
              "conflictingKind",
              "conflictingName",
            ]) ||
            typeof value.alias !== "string" ||
            typeof value.conflictingCode !== "string" ||
            typeof value.conflictingName !== "string"
          ) {
            return [];
          }
          return [
            `${value.alias} → ${value.conflictingName} (${value.conflictingCode})`,
          ];
        });
        return {
          conflicts: Object.freeze(conflicts),
          status: "ALIAS_CONFLICT",
        };
      }
      return {
        code:
          exact(body, ["code", "status"]) && typeof body.code === "string"
            ? body.code
            : exact(body, ["code"]) && typeof body.code === "string"
              ? body.code
              : "CONFLICT",
        status: "CONFLICT",
      };
    }
    return response.ok
      ? { status: "OK" }
      : { code: "ADMIN_TAXONOMY_UNAVAILABLE", status: "UNAVAILABLE" };
  } catch {
    return { code: "ADMIN_TAXONOMY_UNAVAILABLE", status: "UNAVAILABLE" };
  }
}

async function loadItems(
  path: string,
  fetcher: typeof fetch,
): Promise<AdminTaxonomyLoadResult<readonly AdminTaxonomyItem[]>> {
  try {
    const response = await fetcher(path, readOptions());
    const denied = statusResult(response.status);
    if (denied !== null) return denied;
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (!exact(body, ["items"]) || !Array.isArray(body.items)) {
      return { status: "UNAVAILABLE" };
    }
    const items = body.items.map(parseItem);
    if (items.some((item) => item === null)) {
      return { status: "UNAVAILABLE" };
    }
    return {
      data: Object.freeze(items as AdminTaxonomyItem[]),
      status: "OK",
    };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

function parseItem(value: unknown): AdminTaxonomyItem | null {
  if (
    !exact(value, [
      "aliases",
      "code",
      "description",
      "kind",
      "name",
      "primaryProfessionCode",
      "professionCodes",
      "releaseVersion",
      "replacedByCode",
      "slug",
      "state",
    ]) ||
    !Array.isArray(value.aliases) ||
    !value.aliases.every((alias) => bounded(alias, 2, 100)) ||
    !taxonomyCode(value.code) ||
    !(value.description === null || bounded(value.description, 4, 500)) ||
    !kind(value.kind) ||
    !bounded(value.name, 2, 120) ||
    !(
      value.primaryProfessionCode === null ||
      professionCode(value.primaryProfessionCode)
    ) ||
    !Array.isArray(value.professionCodes) ||
    !value.professionCodes.every(professionCode) ||
    !Number.isSafeInteger(value.releaseVersion) ||
    Number(value.releaseVersion) < 1 ||
    !(value.replacedByCode === null || taxonomyCode(value.replacedByCode)) ||
    !bounded(value.slug, 1, 100) ||
    (value.state !== "ACTIVE" && value.state !== "DEPRECATED")
  ) {
    return null;
  }
  return Object.freeze({
    ...(value as unknown as AdminTaxonomyItem),
    aliases: Object.freeze([...value.aliases]),
    professionCodes: Object.freeze([...value.professionCodes]),
  });
}

function parseSuggestion(value: unknown): AdminTaxonomySuggestion | null {
  if (
    !exact(value, [
      "adminDecisionNote",
      "createdAt",
      "decidedAt",
      "id",
      "proposedDescription",
      "proposedName",
      "requesterCraftsmanProfileId",
      "resolvedTaxonomyCode",
      "resolvedTaxonomyLabel",
      "revision",
      "state",
      "suggestedKind",
    ]) ||
    !(
      value.adminDecisionNote === null ||
      bounded(value.adminDecisionNote, 3, 500)
    ) ||
    !iso(value.createdAt) ||
    !(value.decidedAt === null || iso(value.decidedAt)) ||
    !uuid(value.id) ||
    !bounded(value.proposedDescription, 10, 1_000) ||
    !bounded(value.proposedName, 2, 100) ||
    !uuid(value.requesterCraftsmanProfileId) ||
    !(
      value.resolvedTaxonomyCode === null ||
      taxonomyCode(value.resolvedTaxonomyCode)
    ) ||
    !(
      value.resolvedTaxonomyLabel === null ||
      bounded(value.resolvedTaxonomyLabel, 2, 120)
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !["PENDING", "APPROVED_AS_NEW", "MAPPED_TO_EXISTING", "REJECTED"].includes(
      String(value.state),
    ) ||
    !(value.suggestedKind === null || kind(value.suggestedKind))
  ) {
    return null;
  }
  return Object.freeze(value) as unknown as AdminTaxonomySuggestion;
}

async function csrf(fetcher: typeof fetch): Promise<
  | { readonly token: string; readonly status: "OK" }
  | {
      readonly code: string;
      readonly status: "AUTH_REQUIRED" | "UNAVAILABLE";
    }
> {
  const response = await fetcher("/v1/auth/csrf", readOptions());
  if (response.status === 401) {
    return { code: "AUTHENTICATION_REQUIRED", status: "AUTH_REQUIRED" };
  }
  if (!response.ok) {
    return { code: "CSRF_UNAVAILABLE", status: "UNAVAILABLE" };
  }
  const body: unknown = await response.json();
  return exact(body, ["csrfToken"]) && bounded(body.csrfToken, 1, 1_000)
    ? { status: "OK", token: body.csrfToken }
    : { code: "CSRF_UNAVAILABLE", status: "UNAVAILABLE" };
}

function readOptions(): RequestInit {
  return {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  };
}

function statusResult(
  status: number,
): Exclude<AdminTaxonomyLoadResult<never>, { status: "OK" }> | null {
  if (status === 401) return { status: "AUTH_REQUIRED" };
  if (status === 403) return { status: "DENIED" };
  return null;
}

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|")
  );
}
function bounded(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}
function kind(value: unknown): value is AdminTaxonomyKind {
  return value === "PROFESSION" || value === "SERVICE";
}
function professionCode(value: unknown): value is string {
  return (
    typeof value === "string" && /^PROF:[A-Z][A-Z0-9_]{1,62}$/u.test(value)
  );
}
function taxonomyCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|SERV):[A-Z][A-Z0-9_]{1,62}$/u.test(value)
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
function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
