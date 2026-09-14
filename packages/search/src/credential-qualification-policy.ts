import { createHash } from "node:crypto";

import type { CredentialQualificationPersistence } from "./credential-qualification.js";

export interface CredentialQualificationPolicyEntrySeed {
  readonly credentialTypeCode: string;
  readonly professionCode: string;
  readonly requirement: "REQUIRED" | "OPTIONAL";
}

export interface CredentialQualificationPolicyReleaseSeed {
  readonly entries: readonly CredentialQualificationPolicyEntrySeed[];
  readonly releaseId: string;
  readonly reviewReference: string;
  readonly supersedesReleaseId: string | null;
  readonly taxonomyReleaseId: string;
  readonly version: number;
}

export interface PreparedCredentialQualificationPolicyRelease extends CredentialQualificationPolicyReleaseSeed {
  readonly checksumSha256: string;
  readonly contentClass: "CANONICAL";
  readonly reviewState: "HUMAN_REVIEW_APPROVED";
}

export interface CredentialQualificationPolicyActivationInput {
  readonly activationId: string;
  readonly actorReference: string;
  readonly previousReleaseId: string | null;
  readonly releaseId: string;
  readonly reviewReference: string;
}

export interface CredentialQualificationPolicyPersistence extends CredentialQualificationPersistence {
  activateRelease(
    input: CredentialQualificationPolicyActivationInput,
  ): Promise<boolean>;
  installRelease(
    release: PreparedCredentialQualificationPolicyRelease,
  ): Promise<"CREATED" | "UNCHANGED">;
}

export function prepareCredentialQualificationPolicyRelease(
  input: CredentialQualificationPolicyReleaseSeed,
): PreparedCredentialQualificationPolicyRelease {
  validateRelease(input);
  const entries = Object.freeze(
    input.entries
      .map((entry) => Object.freeze({ ...entry }))
      .sort(
        (left, right) =>
          codePointCompare(left.professionCode, right.professionCode) ||
          codePointCompare(left.credentialTypeCode, right.credentialTypeCode),
      ),
  );
  const release = Object.freeze({
    contentClass: "CANONICAL" as const,
    entries,
    releaseId: input.releaseId,
    reviewReference: input.reviewReference,
    reviewState: "HUMAN_REVIEW_APPROVED" as const,
    supersedesReleaseId: input.supersedesReleaseId,
    taxonomyReleaseId: input.taxonomyReleaseId,
    version: input.version,
  });
  return Object.freeze({
    ...release,
    checksumSha256: checksum(release),
  });
}

export function assertPreparedCredentialQualificationPolicyRelease(
  release: PreparedCredentialQualificationPolicyRelease,
): void {
  const prepared = prepareCredentialQualificationPolicyRelease(release);
  if (
    release.contentClass !== "CANONICAL" ||
    release.reviewState !== "HUMAN_REVIEW_APPROVED" ||
    release.checksumSha256 !== prepared.checksumSha256 ||
    JSON.stringify(release.entries) !== JSON.stringify(prepared.entries)
  ) {
    throw new TypeError(
      "Credential qualification policy checksum or canonical ordering is invalid.",
    );
  }
}

export function createCredentialQualificationPolicyService(input: {
  readonly persistence: CredentialQualificationPolicyPersistence;
}) {
  return Object.freeze({
    activateRelease(activation: CredentialQualificationPolicyActivationInput) {
      assertActivation(activation);
      return input.persistence.activateRelease(activation);
    },
    installRelease(release: CredentialQualificationPolicyReleaseSeed) {
      return input.persistence.installRelease(
        prepareCredentialQualificationPolicyRelease(release),
      );
    },
  });
}

function validateRelease(input: CredentialQualificationPolicyReleaseSeed) {
  if (
    !isUuid(input.releaseId) ||
    !isUuid(input.taxonomyReleaseId) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    (input.version === 1) !== (input.supersedesReleaseId === null) ||
    (input.supersedesReleaseId !== null &&
      (!isUuid(input.supersedesReleaseId) ||
        input.supersedesReleaseId === input.releaseId)) ||
    !safeReference(input.reviewReference) ||
    input.entries.length < 1 ||
    input.entries.length > 2_000
  ) {
    throw new TypeError("Credential qualification policy release is invalid.");
  }
  const identities = new Set<string>();
  for (const entry of input.entries) {
    const identity = `${entry.professionCode}\u0000${entry.credentialTypeCode}`;
    if (
      !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(entry.professionCode) ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(entry.credentialTypeCode) ||
      entry.credentialTypeCode.length > 64 ||
      (entry.requirement !== "REQUIRED" && entry.requirement !== "OPTIONAL") ||
      identities.has(identity)
    ) {
      throw new TypeError("Credential qualification policy entry is invalid.");
    }
    identities.add(identity);
  }
}

function assertActivation(input: CredentialQualificationPolicyActivationInput) {
  if (
    !isUuid(input.activationId) ||
    !isUuid(input.releaseId) ||
    (input.previousReleaseId !== null && !isUuid(input.previousReleaseId)) ||
    !safeReference(input.actorReference) ||
    !safeReference(input.reviewReference)
  ) {
    throw new TypeError("Credential qualification activation is invalid.");
  }
}

function checksum(value: object): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function safeReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
