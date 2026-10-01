export const TAXONOMY_SUGGESTION_STATES = Object.freeze([
  "PENDING",
  "APPROVED_AS_NEW",
  "MAPPED_TO_EXISTING",
  "REJECTED",
] as const);
export type TaxonomySuggestionState =
  (typeof TAXONOMY_SUGGESTION_STATES)[number];

export const TAXONOMY_SUGGESTION_KINDS = Object.freeze([
  "PROFESSION",
  "SERVICE",
] as const);
export type TaxonomySuggestionKind = (typeof TAXONOMY_SUGGESTION_KINDS)[number];

export const TAXONOMY_SUGGESTION_LIMITS = Object.freeze({
  aliasesPerApproval: 40,
  decisionNote: 500,
  pendingPerCraftsmanProfile: 5,
  proposedDescription: 1_000,
  proposedName: 100,
} as const);

export interface TaxonomySuggestion {
  readonly id: string;
  readonly requesterUserId: string;
  readonly requesterCraftsmanProfileId: string;
  readonly proposedName: string;
  readonly normalizedProposedName: string;
  readonly proposedDescription: string;
  readonly suggestedKind: TaxonomySuggestionKind | null;
  readonly state: TaxonomySuggestionState;
  readonly revision: number;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByAdminId: string | null;
  readonly adminDecisionNote: string | null;
  readonly resolvedTaxonomyCode: string | null;
  readonly resolvedTaxonomyLabel: string | null;
}

export interface SubmitTaxonomySuggestionInput {
  readonly suggestionId: string;
  readonly commandId: string;
  readonly actorUserId: string;
  readonly requesterCraftsmanProfileId: string;
  readonly proposedName: string;
  readonly proposedDescription: string;
  readonly suggestedKind?: TaxonomySuggestionKind | null;
}

interface DecisionBase {
  readonly suggestionId: string;
  readonly commandId: string;
  readonly actorAdminUserId: string;
  readonly expectedRevision: number;
}

export type DecideTaxonomySuggestionInput = Readonly<
  | (DecisionBase & {
      decision: "APPROVED_AS_NEW";
      canonicalCode: string;
      canonicalName: string;
      canonicalKind: TaxonomySuggestionKind;
      canonicalDescription: string | null;
      aliases: readonly string[];
      primaryProfessionCode: string | null;
      professionCodes: readonly string[];
      adminDecisionNote?: string | null;
    })
  | (DecisionBase & {
      decision: "MAPPED_TO_EXISTING";
      resolvedTaxonomyCode: string;
      resolvedKind: TaxonomySuggestionKind;
      addProposedNameAsAlias: boolean;
      adminDecisionNote: string;
    })
  | (DecisionBase & {
      decision: "REJECTED";
      adminDecisionNote: string;
    })
>;

export type SubmitTaxonomySuggestionResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      suggestion: TaxonomySuggestion;
    }
  | {
      status:
        "PROFILE_UNAVAILABLE" | "PENDING_LIMIT_REACHED" | "DUPLICATE_PENDING";
    }
>;

export type DecideTaxonomySuggestionResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      suggestion: TaxonomySuggestion;
    }
  | {
      status:
        | "SUGGESTION_UNAVAILABLE"
        | "SUGGESTION_NOT_PENDING"
        | "STALE_REVISION"
        | "TAXONOMY_ITEM_UNAVAILABLE"
        | "CANONICAL_CODE_CONFLICT"
        | "ALIAS_CONFLICT";
    }
>;

export interface TaxonomySuggestionPersistence {
  submit(
    input: SubmitTaxonomySuggestionInput & {
      readonly normalizedProposedName: string;
    },
  ): Promise<SubmitTaxonomySuggestionResult>;
  decide(
    input: DecideTaxonomySuggestionInput,
  ): Promise<DecideTaxonomySuggestionResult>;
}

export class TaxonomySuggestionValidationError extends TypeError {
  readonly code = "INVALID_TAXONOMY_SUGGESTION_COMMAND";
}

export function createTaxonomySuggestionService(dependencies: {
  readonly persistence: TaxonomySuggestionPersistence;
}) {
  return Object.freeze({
    decide(input: DecideTaxonomySuggestionInput) {
      return dependencies.persistence.decide(
        normalizeTaxonomySuggestionDecision(input),
      );
    },
    submit(input: SubmitTaxonomySuggestionInput) {
      const normalized = normalizeSubmitTaxonomySuggestionInput(input);
      const normalizedProposedName = normalizeTaxonomySuggestionLookup(
        normalized.proposedName,
      );
      if (normalizedProposedName.length < 2) {
        throw invalid("proposedName");
      }
      return dependencies.persistence.submit({
        ...normalized,
        normalizedProposedName,
      });
    },
  });
}

export function normalizeSubmitTaxonomySuggestionInput(
  input: SubmitTaxonomySuggestionInput,
): SubmitTaxonomySuggestionInput {
  assertExactKeys(
    input,
    [
      "actorUserId",
      "commandId",
      "proposedDescription",
      "proposedName",
      "requesterCraftsmanProfileId",
      "suggestedKind",
      "suggestionId",
    ],
    ["suggestedKind"],
  );
  assertUuid(input.suggestionId, "suggestionId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.requesterCraftsmanProfileId, "requesterCraftsmanProfileId");
  const suggestedKind = input.suggestedKind ?? null;
  if (
    suggestedKind !== null &&
    !TAXONOMY_SUGGESTION_KINDS.includes(suggestedKind)
  ) {
    throw invalid("suggestedKind");
  }
  return Object.freeze({
    actorUserId: input.actorUserId,
    commandId: input.commandId,
    proposedDescription: normalizeHumanText(
      input.proposedDescription,
      10,
      TAXONOMY_SUGGESTION_LIMITS.proposedDescription,
      "proposedDescription",
    ),
    proposedName: normalizeHumanText(
      input.proposedName,
      2,
      TAXONOMY_SUGGESTION_LIMITS.proposedName,
      "proposedName",
    ),
    requesterCraftsmanProfileId: input.requesterCraftsmanProfileId,
    suggestedKind,
    suggestionId: input.suggestionId,
  });
}

export function normalizeTaxonomySuggestionDecision(
  input: DecideTaxonomySuggestionInput,
): DecideTaxonomySuggestionInput {
  const commonKeys = [
    "actorAdminUserId",
    "commandId",
    "decision",
    "expectedRevision",
    "suggestionId",
  ];
  assertUuid(input.suggestionId, "suggestionId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.actorAdminUserId, "actorAdminUserId");
  assertPositiveRevision(input.expectedRevision);

  if (input.decision === "APPROVED_AS_NEW") {
    assertExactKeys(
      input,
      [
        ...commonKeys,
        "adminDecisionNote",
        "aliases",
        "canonicalCode",
        "canonicalDescription",
        "canonicalKind",
        "canonicalName",
        "primaryProfessionCode",
        "professionCodes",
      ],
      ["adminDecisionNote"],
    );
    assertKind(input.canonicalKind, "canonicalKind");
    const canonicalCode = normalizeCanonicalCode(
      input.canonicalCode,
      input.canonicalKind,
    );
    const canonicalName = normalizeHumanText(
      input.canonicalName,
      2,
      100,
      "canonicalName",
    );
    const canonicalDescription =
      input.canonicalDescription === null
        ? null
        : normalizeHumanText(
            input.canonicalDescription,
            4,
            500,
            "canonicalDescription",
          );
    const aliases = normalizeAliases(input.aliases, canonicalName);
    const professionCodes = normalizeProfessionCodes(
      input.professionCodes,
      input.canonicalKind,
    );
    const primaryProfessionCode = normalizePrimaryProfessionCode(
      input.primaryProfessionCode,
      input.canonicalKind,
      professionCodes,
    );
    return Object.freeze({
      actorAdminUserId: input.actorAdminUserId,
      adminDecisionNote: normalizeOptionalDecisionNote(input.adminDecisionNote),
      aliases,
      canonicalCode,
      canonicalDescription,
      canonicalKind: input.canonicalKind,
      canonicalName,
      commandId: input.commandId,
      decision: input.decision,
      expectedRevision: input.expectedRevision,
      primaryProfessionCode,
      professionCodes,
      suggestionId: input.suggestionId,
    });
  }

  if (input.decision === "MAPPED_TO_EXISTING") {
    assertExactKeys(input, [
      ...commonKeys,
      "addProposedNameAsAlias",
      "adminDecisionNote",
      "resolvedKind",
      "resolvedTaxonomyCode",
    ]);
    assertKind(input.resolvedKind, "resolvedKind");
    if (typeof input.addProposedNameAsAlias !== "boolean") {
      throw invalid("addProposedNameAsAlias");
    }
    return Object.freeze({
      actorAdminUserId: input.actorAdminUserId,
      addProposedNameAsAlias: input.addProposedNameAsAlias,
      adminDecisionNote: normalizeRequiredDecisionNote(input.adminDecisionNote),
      commandId: input.commandId,
      decision: input.decision,
      expectedRevision: input.expectedRevision,
      resolvedKind: input.resolvedKind,
      resolvedTaxonomyCode: normalizeCanonicalCode(
        input.resolvedTaxonomyCode,
        input.resolvedKind,
      ),
      suggestionId: input.suggestionId,
    });
  }

  if (input.decision === "REJECTED") {
    assertExactKeys(input, [...commonKeys, "adminDecisionNote"]);
    return Object.freeze({
      actorAdminUserId: input.actorAdminUserId,
      adminDecisionNote: normalizeRequiredDecisionNote(input.adminDecisionNote),
      commandId: input.commandId,
      decision: input.decision,
      expectedRevision: input.expectedRevision,
      suggestionId: input.suggestionId,
    });
  }
  throw invalid("decision");
}

function normalizePrimaryProfessionCode(
  value: string | null,
  kind: TaxonomySuggestionKind,
  professionCodes: readonly string[],
): string | null {
  if (kind === "PROFESSION") {
    if (value !== null) throw invalid("primaryProfessionCode");
    return null;
  }
  if (
    typeof value !== "string" ||
    !/^PROF:[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value) ||
    !professionCodes.includes(value)
  ) {
    throw invalid("primaryProfessionCode");
  }
  return value;
}

function normalizeProfessionCodes(
  values: readonly string[],
  kind: TaxonomySuggestionKind,
): readonly string[] {
  const candidates: unknown = values;
  if (!isStringArray(candidates)) throw invalid("professionCodes");
  if (kind === "PROFESSION") {
    if (candidates.length !== 0) throw invalid("professionCodes");
    return Object.freeze([]);
  }
  if (
    candidates.length < 1 ||
    candidates.length > 8 ||
    new Set(candidates).size !== candidates.length
  ) {
    throw invalid("professionCodes");
  }
  if (
    candidates.some((value) => !/^PROF:[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value))
  ) {
    throw invalid("professionCodes");
  }
  return Object.freeze([...candidates].sort());
}

export function assertTaxonomySuggestionDecisionAllowed(
  suggestion: Pick<TaxonomySuggestion, "revision" | "state">,
  decision: Pick<DecideTaxonomySuggestionInput, "expectedRevision">,
): void {
  if (suggestion.state !== "PENDING") {
    throw invalid("state");
  }
  if (suggestion.revision !== decision.expectedRevision) {
    throw invalid("expectedRevision");
  }
}

/** Accent-, case-, whitespace- and separator-insensitive duplicate key. */
export function normalizeTaxonomySuggestionLookup(value: string): string {
  if (typeof value !== "string") throw invalid("proposedName");
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("sk")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function normalizeAliases(
  values: readonly string[],
  canonicalName: string,
): readonly string[] {
  const candidates: unknown = values;
  if (
    !isStringArray(candidates) ||
    candidates.length > TAXONOMY_SUGGESTION_LIMITS.aliasesPerApproval
  ) {
    throw invalid("aliases");
  }
  const canonicalKey = normalizeTaxonomySuggestionLookup(canonicalName);
  const seen = new Set<string>();
  const aliases = candidates.map((value) => {
    const alias = normalizeHumanText(value, 2, 100, "aliases");
    const key = normalizeTaxonomySuggestionLookup(alias);
    if (key === canonicalKey || seen.has(key)) throw invalid("aliases");
    seen.add(key);
    return alias;
  });
  return Object.freeze(aliases);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown): item is string => typeof item === "string")
  );
}

function normalizeCanonicalCode(
  value: string,
  kind: TaxonomySuggestionKind,
): string {
  if (typeof value !== "string") throw invalid("canonicalCode");
  const normalized = value.trim().toUpperCase();
  const expectedPrefix = kind === "PROFESSION" ? "PROF:" : "SERV:";
  if (
    !/^(?:PROF|SERV):[A-Z][A-Z0-9_]{1,62}$/u.test(normalized) ||
    !normalized.startsWith(expectedPrefix)
  ) {
    throw invalid("canonicalCode");
  }
  return normalized;
}

function normalizeRequiredDecisionNote(value: string): string {
  return normalizeHumanText(
    value,
    8,
    TAXONOMY_SUGGESTION_LIMITS.decisionNote,
    "adminDecisionNote",
  );
}

function normalizeOptionalDecisionNote(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeHumanText(
    value,
    3,
    TAXONOMY_SUGGESTION_LIMITS.decisionNote,
    "adminDecisionNote",
  );
}

function normalizeHumanText(
  value: string,
  minimum: number,
  maximum: number,
  field: string,
): string {
  if (typeof value !== "string") throw invalid(field);
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    hasControlCharacter(normalized)
  ) {
    throw invalid(field);
  }
  return normalized;
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    keys.some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !optionalSet.has(key) && !keys.includes(key))
  ) {
    throw invalid("shape");
  }
}

function assertKind(value: string, field: string): void {
  if (!TAXONOMY_SUGGESTION_KINDS.includes(value as TaxonomySuggestionKind)) {
    throw invalid(field);
  }
}

function assertPositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("expectedRevision");
  }
}

function assertUuid(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function invalid(field: string): TaxonomySuggestionValidationError {
  return new TaxonomySuggestionValidationError(
    `Invalid taxonomy suggestion command field: ${field}.`,
  );
}
