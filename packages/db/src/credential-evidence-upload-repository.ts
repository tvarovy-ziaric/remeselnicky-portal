import type {
  CredentialClaimId,
  CredentialEvidenceRequirement,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type {
  CredentialEvidenceUploadAuthorization,
  CredentialEvidenceUploadStatus,
} from "@portal/media";
import type { Sql } from "postgres";

import type { CredentialClaimRepository } from "./credential-claim-repository.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const credentialTypeCodePattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const maximumReturnedUploads = 64;
const maximumReturnedTypes = 128;

export interface ActiveCredentialType {
  readonly code: string;
  readonly evidenceRequirement: CredentialEvidenceRequirement;
}

export interface CredentialTypeReadRepository {
  listActive(): Promise<readonly ActiveCredentialType[]>;
}

type ListInput = Parameters<
  CredentialEvidenceUploadAuthorization["listOwnedUploads"]
>[0];
type PrepareInput = Parameters<
  CredentialEvidenceUploadAuthorization["prepareUpload"]
>[0];

export function createCredentialEvidenceUploadAuthorization(
  sql: Sql,
  claims: CredentialClaimRepository,
): CredentialEvidenceUploadAuthorization {
  return Object.freeze({
    async listOwnedUploads(
      input: ListInput,
    ): Promise<readonly CredentialEvidenceUploadStatus[]> {
      if (!validIdentity(input)) return [];
      const rows = await sql<
        Array<{
          readonly assetId: string;
          readonly kind: string;
          readonly status: string;
        }>
      >`
        SELECT asset.id AS "assetId", asset.kind, asset.status
        FROM users actor
        JOIN craftsman_profiles profile ON profile.owner_user_id = actor.id
        JOIN credential_claims claim ON claim.craftsman_profile_id = profile.id
        JOIN media_assets asset
          ON asset.owner_user_id = actor.id
          AND asset.uploaded_by_user_id = actor.id
          AND asset.provenance_entity_type = 'CREDENTIAL'
          AND asset.provenance_entity_id = claim.id
          AND asset.provenance_entity_revision = claim.revision
          AND (
            (asset.kind = 'DOCUMENT' AND asset.purpose::text = 'CREDENTIAL_DOCUMENT')
            OR (asset.kind = 'IMAGE' AND asset.purpose::text = 'CREDENTIAL_IMAGE')
          )
        WHERE actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
          AND profile.id = ${input.craftsmanProfileId}
          AND claim.id = ${input.claimId}
        ORDER BY asset.created_at DESC, asset.id DESC
        LIMIT ${maximumReturnedUploads}
      `;
      return Object.freeze(rows.map(parseUploadRow));
    },
    async prepareUpload(input: PrepareInput) {
      if (
        !validIdentity(input) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        (input.mediaKind !== "DOCUMENT" && input.mediaKind !== "IMAGE")
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const prepared = await claims.prepareEvidenceUpload({
        actorUserId: input.actorUserId as UserId,
        claimId: input.claimId as CredentialClaimId,
        craftsmanProfileId: input.craftsmanProfileId as CraftsmanProfileId,
        expectedRevision: input.expectedRevision,
        mediaKind: input.mediaKind,
      });
      if (prepared.status !== "READY") {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      if (
        prepared.purpose !== "CREDENTIAL_DOCUMENT" &&
        prepared.purpose !== "CREDENTIAL_IMAGE"
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      return Object.freeze({
        provenance: prepared.provenance,
        purpose: prepared.purpose,
        status: "AUTHORIZED" as const,
      });
    },
  });
}

export function createCredentialTypeReadRepository(
  sql: Sql,
): CredentialTypeReadRepository {
  return Object.freeze({
    async listActive(): Promise<readonly ActiveCredentialType[]> {
      const rows = await sql<
        Array<{ readonly code: string; readonly evidenceRequirement: string }>
      >`
        SELECT code, evidence_requirement AS "evidenceRequirement"
        FROM credential_type_policies
        WHERE active = true
        ORDER BY code
        LIMIT ${maximumReturnedTypes}
      `;
      return Object.freeze(
        rows.map((row) => {
          if (
            row.code.length > 64 ||
            !credentialTypeCodePattern.test(row.code) ||
            (row.evidenceRequirement !== "REQUIRED" &&
              row.evidenceRequirement !== "OPTIONAL")
          ) {
            throw new Error("Active credential type row is invalid.");
          }
          return Object.freeze({
            code: row.code,
            evidenceRequirement: row.evidenceRequirement,
          });
        }),
      );
    },
  });
}

function parseUploadRow(row: {
  readonly assetId: string;
  readonly kind: string;
  readonly status: string;
}): CredentialEvidenceUploadStatus {
  if (
    !uuidPattern.test(row.assetId) ||
    (row.kind !== "DOCUMENT" && row.kind !== "IMAGE") ||
    (row.status !== "PROCESSING" &&
      row.status !== "READY" &&
      row.status !== "REJECTED")
  ) {
    throw new Error("Credential evidence upload row is invalid.");
  }
  return Object.freeze({
    assetId: row.assetId,
    kind: row.kind,
    status: row.status,
  });
}

function validIdentity(input: {
  readonly actorUserId: string;
  readonly claimId: string;
  readonly craftsmanProfileId: string;
}): boolean {
  return (
    uuidPattern.test(input.actorUserId) &&
    uuidPattern.test(input.claimId) &&
    uuidPattern.test(input.craftsmanProfileId)
  );
}
