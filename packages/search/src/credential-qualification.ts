export const CREDENTIAL_QUALIFICATION_REQUIREMENTS = Object.freeze([
  "REQUIRED",
  "OPTIONAL",
] as const);
export type CredentialQualificationRequirement =
  (typeof CREDENTIAL_QUALIFICATION_REQUIREMENTS)[number];

export const CREDENTIAL_QUALIFICATION_REASONS = Object.freeze([
  "REQUIRED_CREDENTIAL_APPROVED",
  "REQUIRED_CREDENTIAL_MISSING",
  "OPTIONAL_CREDENTIAL_APPROVED",
  "OPTIONAL_CREDENTIAL_NOT_APPROVED",
] as const);
export type CredentialQualificationReason =
  (typeof CREDENTIAL_QUALIFICATION_REASONS)[number];

export interface CredentialQualificationInput {
  /** Public profile identity selected by the server-side candidate pipeline. */
  readonly craftsmanProfileId: string;
  /** Exact canonical profession derived from the selected service. */
  readonly professionCode: string;
  /** Exact governed credential type derived from the qualification policy. */
  readonly credentialTypeCode: string;
}

export interface CredentialQualificationRow {
  readonly currentApproved: unknown;
  readonly eligibility: unknown;
  readonly reasonCode: unknown;
  readonly requirement: unknown;
}

export interface CredentialQualificationPersistence {
  evaluate(
    input: CredentialQualificationInput,
  ): Promise<CredentialQualificationRow | null>;
}

export type CredentialQualificationResult = Readonly<
  | {
      readonly status: "OK";
      readonly eligible: boolean;
      readonly requirement: CredentialQualificationRequirement;
      readonly currentApproved: boolean;
      readonly reasonCode: CredentialQualificationReason;
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly eligible: false;
    }
>;

export class CredentialQualificationValidationError extends TypeError {
  override readonly name = "CredentialQualificationValidationError";
}

export interface CredentialQualificationGate {
  evaluate(
    input: CredentialQualificationInput,
  ): Promise<CredentialQualificationResult>;
}

export function createCredentialQualificationGate(
  persistence: CredentialQualificationPersistence,
): CredentialQualificationGate {
  return Object.freeze({
    async evaluate(
      input: CredentialQualificationInput,
    ): Promise<CredentialQualificationResult> {
      assertCredentialQualificationInput(input);
      const row = await persistence.evaluate(input);
      return serializeCredentialQualification(row);
    },
  });
}

export function assertCredentialQualificationInput(
  input: CredentialQualificationInput,
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isUuid(input.craftsmanProfileId) ||
    !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(input.professionCode) ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(input.credentialTypeCode) ||
    input.credentialTypeCode.length > 64
  ) {
    throw new CredentialQualificationValidationError(
      "Credential qualification input is invalid.",
    );
  }
}

export function serializeCredentialQualification(
  row: CredentialQualificationRow | null,
): CredentialQualificationResult {
  if (row === null || !isCoherentRow(row)) {
    return Object.freeze({ eligible: false as const, status: "UNAVAILABLE" });
  }
  return Object.freeze({
    currentApproved: row.currentApproved,
    eligible: row.eligibility === "QUALIFIED",
    reasonCode: row.reasonCode,
    requirement: row.requirement,
    status: "OK" as const,
  });
}

function isCoherentRow(
  row: CredentialQualificationRow,
): row is CredentialQualificationRow & {
  readonly currentApproved: boolean;
  readonly eligibility: "QUALIFIED" | "NOT_QUALIFIED";
  readonly reasonCode: CredentialQualificationReason;
  readonly requirement: CredentialQualificationRequirement;
} {
  return (
    (row.requirement === "REQUIRED" &&
      row.currentApproved === true &&
      row.eligibility === "QUALIFIED" &&
      row.reasonCode === "REQUIRED_CREDENTIAL_APPROVED") ||
    (row.requirement === "REQUIRED" &&
      row.currentApproved === false &&
      row.eligibility === "NOT_QUALIFIED" &&
      row.reasonCode === "REQUIRED_CREDENTIAL_MISSING") ||
    (row.requirement === "OPTIONAL" &&
      row.currentApproved === true &&
      row.eligibility === "QUALIFIED" &&
      row.reasonCode === "OPTIONAL_CREDENTIAL_APPROVED") ||
    (row.requirement === "OPTIONAL" &&
      row.currentApproved === false &&
      row.eligibility === "QUALIFIED" &&
      row.reasonCode === "OPTIONAL_CREDENTIAL_NOT_APPROVED")
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
