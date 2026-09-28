import {
  createServerMediaEntityAccess,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";
import type { Sql } from "postgres";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const credentialTypeCode = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

export interface AdminCredentialEvidenceItem {
  readonly assetId: string;
  readonly attachedAt: Date;
  readonly mediaKind: "DOCUMENT" | "IMAGE";
}

export interface AdminCredentialReviewItem {
  readonly claimId: string;
  readonly createdAt: Date;
  readonly credentialTypeCode: string;
  readonly evidence: readonly AdminCredentialEvidenceItem[];
  readonly evidenceRequirement: "OPTIONAL" | "REQUIRED";
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
  readonly state: "APPROVED" | "PENDING";
  readonly updatedAt: Date;
}

export interface AdminCredentialReviewHistoryItem extends Omit<
  AdminCredentialReviewItem,
  "state"
> {
  readonly reviewReason: string | null;
  readonly reviewReasonCategory:
    | "EXPIRED_OR_INVALID"
    | "FALSE_IDENTITY"
    | "FALSE_QUALIFICATION"
    | "INSUFFICIENT_EVIDENCE"
    | "MISLEADING_CLAIM"
    | "OTHER"
    | null;
  readonly reviewedAt: Date;
  readonly state: "APPROVED" | "REJECTED" | "REVOKED";
}

export interface AdminCredentialReviewRepository {
  findReviewable(claimId: string): Promise<AdminCredentialReviewItem | null>;
  listPending(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly AdminCredentialReviewItem[];
    readonly nextCursor: string | null;
  }>;
  listReviewed(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly state: AdminCredentialReviewHistoryItem["state"];
  }): Promise<{
    readonly items: readonly AdminCredentialReviewHistoryItem[];
    readonly nextCursor: string | null;
  }>;
}

interface ReviewRow {
  readonly claimId: string;
  readonly createdAt: Date;
  readonly credentialTypeCode: string;
  readonly evidence: unknown;
  readonly evidenceRequirement: string;
  readonly expiresOn: string | null;
  readonly primaryName: string | null;
  readonly professionCode: string;
  readonly professionId: string;
  readonly professionLabel: string;
  readonly profileId: string;
  readonly profileType: string;
  readonly revision: number;
  readonly reviewReason: string | null;
  readonly reviewReasonCategory: string | null;
  readonly reviewedAt: Date | null;
  readonly secondaryName: string | null;
  readonly state: string;
  readonly updatedAt: Date;
}

export function createAdminCredentialReviewRepository(
  sql: Sql,
): AdminCredentialReviewRepository {
  return Object.freeze({
    async findReviewable(claimId: string) {
      if (!uuid.test(claimId)) return null;
      const rows = await selectReviewable(sql, { claimId, limit: 1 });
      return rows[0] === undefined ? null : parseReviewRow(rows[0]);
    },
    async listPending(input: {
      readonly cursor?: string;
      readonly limit: number;
    }) {
      assertPageInput(input);
      const rows = await selectReviewable(sql, {
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      return Object.freeze({
        items: Object.freeze(page.map(parseReviewRow)),
        nextCursor:
          rows.length > input.limit ? (page.at(-1)?.claimId ?? null) : null,
      });
    },
    async listReviewed(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly state: AdminCredentialReviewHistoryItem["state"];
    }) {
      assertPageInput(input);
      assertReviewedState(input.state);
      const rows = await selectReviewed(sql, {
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
        state: input.state,
      });
      const page = rows.slice(0, input.limit);
      return Object.freeze({
        items: Object.freeze(page.map(parseHistoryRow)),
        nextCursor:
          rows.length > input.limit ? (page.at(-1)?.claimId ?? null) : null,
      });
    },
  });
}

export function createCredentialReviewerMediaAccessResolver(
  sql: Sql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      if (
        snapshot.asset.provenanceEntityType !== "CREDENTIAL" ||
        snapshot.asset.provenanceEntityId === null ||
        snapshot.asset.provenanceEntityRevision === null ||
        (snapshot.asset.purpose !== "CREDENTIAL_DOCUMENT" &&
          snapshot.asset.purpose !== "CREDENTIAL_IMAGE")
      ) {
        return deniedAccess(snapshot.asset.id);
      }
      const [row] = await sql<
        Array<{
          readonly attachedRevision: number;
          readonly claimId: string;
          readonly claimRevision: number;
          readonly claimState: string;
          readonly ownerUserId: string;
        }>
      >`
        SELECT claim.id AS "claimId", claim.revision AS "claimRevision",
          claim.state AS "claimState", claim.created_by_user_id AS "ownerUserId",
          evidence.attached_revision AS "attachedRevision"
        FROM credential_claim_evidence evidence
        JOIN credential_claims claim ON claim.id = evidence.claim_id
        WHERE evidence.media_asset_id = ${snapshot.asset.id}
          AND claim.id = ${snapshot.asset.provenanceEntityId}
          AND claim.state IN ('PENDING', 'APPROVED')
          AND EXISTS (
            SELECT 1
            FROM users reviewer
            JOIN admin_role_grants role ON role.user_id = reviewer.id
              AND role.revoked_at IS NULL
              AND role.role IN ('ADMIN', 'SUPER_ADMIN')
            WHERE reviewer.id = ${snapshot.actor.userId}
              AND reviewer.account_state = 'ACTIVE'
          )
      `;
      if (
        row === undefined ||
        !uuid.test(row.claimId) ||
        row.ownerUserId !== snapshot.asset.ownerUserId ||
        row.attachedRevision !== snapshot.asset.provenanceEntityRevision + 1 ||
        !Number.isSafeInteger(row.claimRevision) ||
        row.claimRevision < row.attachedRevision ||
        (row.claimState !== "PENDING" && row.claimState !== "APPROVED")
      ) {
        return deniedAccess(snapshot.asset.id);
      }
      return createServerMediaEntityAccess({
        grants: ["CREDENTIAL_REVIEWER"],
        revision: `credential:${row.claimId}:${row.claimRevision}:${row.claimState}:${row.attachedRevision}`,
      });
    },
  });
}

async function selectReviewable(
  sql: Sql,
  input:
    | { readonly claimId: string; readonly limit: number }
    | { readonly cursor: string | null; readonly limit: number },
): Promise<ReviewRow[]> {
  const exactClaimId = "claimId" in input ? input.claimId : null;
  const cursor = "cursor" in input ? input.cursor : null;
  return sql<ReviewRow[]>`
    SELECT claim.id AS "claimId", claim.credential_type_code AS "credentialTypeCode",
      claim.evidence_requirement AS "evidenceRequirement", claim.expires_on::text AS "expiresOn",
      claim.state, claim.revision, claim.review_reason AS "reviewReason",
      claim.review_reason_category AS "reviewReasonCategory", claim.reviewed_at AS "reviewedAt",
      claim.created_at AS "createdAt", claim.updated_at AS "updatedAt",
      profile.id AS "profileId", profile.profile_type AS "profileType",
      NULLIF(CASE WHEN profile.profile_type = 'COMPANY' THEN profile.official_company_name
        ELSE COALESCE(profile.nickname, concat_ws(' ', profile.real_first_name, profile.real_last_name))
      END, '') AS "primaryName",
      NULLIF(CASE WHEN profile.profile_type = 'INDIVIDUAL' AND profile.nickname IS NOT NULL
        THEN concat_ws(' ', profile.real_first_name, profile.real_last_name) ELSE NULL
      END, '') AS "secondaryName",
      profession.id AS "professionId", profession.profession_code AS "professionCode",
      taxonomy.label_sk AS "professionLabel", COALESCE(evidence.items, '[]'::jsonb) AS evidence
    FROM credential_claims claim
    JOIN craftsman_profiles profile ON profile.id = claim.craftsman_profile_id
    JOIN users owner ON owner.id = profile.owner_user_id
    JOIN craftsman_professions profession ON profession.id = claim.craftsman_profession_id
    JOIN taxonomy_professions taxonomy ON taxonomy.release_id = profession.taxonomy_release_id
      AND taxonomy.profession_code = profession.profession_code
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'assetId', item.media_asset_id, 'attachedAt', item.attached_at,
        'mediaKind', item.media_kind
      ) ORDER BY item.attached_revision, item.media_asset_id) AS items
      FROM credential_claim_evidence item WHERE item.claim_id = claim.id
    ) evidence ON true
    WHERE claim.state IN ('PENDING', 'APPROVED')
      AND (claim.state = 'APPROVED' OR owner.account_state = 'ACTIVE')
      AND (${exactClaimId}::uuid IS NULL OR claim.id = ${exactClaimId})
      AND (${exactClaimId}::uuid IS NOT NULL OR claim.state = 'PENDING')
      AND (${cursor}::uuid IS NULL OR claim.id > ${cursor})
    ORDER BY claim.id
    LIMIT ${input.limit}
  `;
}

async function selectReviewed(
  sql: Sql,
  input: {
    readonly cursor: string | null;
    readonly limit: number;
    readonly state: AdminCredentialReviewHistoryItem["state"];
  },
): Promise<ReviewRow[]> {
  return sql<ReviewRow[]>`
    SELECT claim.id AS "claimId", claim.credential_type_code AS "credentialTypeCode",
      claim.evidence_requirement AS "evidenceRequirement", claim.expires_on::text AS "expiresOn",
      claim.state, claim.revision, claim.review_reason AS "reviewReason",
      claim.review_reason_category AS "reviewReasonCategory", claim.reviewed_at AS "reviewedAt",
      claim.created_at AS "createdAt", claim.updated_at AS "updatedAt",
      profile.id AS "profileId", profile.profile_type AS "profileType",
      NULLIF(CASE WHEN profile.profile_type = 'COMPANY' THEN profile.official_company_name
        ELSE COALESCE(profile.nickname, concat_ws(' ', profile.real_first_name, profile.real_last_name))
      END, '') AS "primaryName",
      NULLIF(CASE WHEN profile.profile_type = 'INDIVIDUAL' AND profile.nickname IS NOT NULL
        THEN concat_ws(' ', profile.real_first_name, profile.real_last_name) ELSE NULL
      END, '') AS "secondaryName",
      profession.id AS "professionId", profession.profession_code AS "professionCode",
      taxonomy.label_sk AS "professionLabel", COALESCE(evidence.items, '[]'::jsonb) AS evidence
    FROM credential_claims claim
    JOIN craftsman_profiles profile ON profile.id = claim.craftsman_profile_id
    JOIN craftsman_professions profession ON profession.id = claim.craftsman_profession_id
    JOIN taxonomy_professions taxonomy ON taxonomy.release_id = profession.taxonomy_release_id
      AND taxonomy.profession_code = profession.profession_code
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'assetId', item.media_asset_id, 'attachedAt', item.attached_at,
        'mediaKind', item.media_kind
      ) ORDER BY item.attached_revision, item.media_asset_id) AS items
      FROM credential_claim_evidence item WHERE item.claim_id = claim.id
    ) evidence ON true
    WHERE claim.state = ${input.state}
      AND (${input.cursor}::uuid IS NULL OR claim.id > ${input.cursor})
    ORDER BY claim.id
    LIMIT ${input.limit}
  `;
}

function parseReviewRow(row: ReviewRow): AdminCredentialReviewItem {
  const evidence = parseEvidence(row.evidence);
  if (
    !uuid.test(row.claimId) ||
    !uuid.test(row.profileId) ||
    !uuid.test(row.professionId) ||
    !credentialTypeCode.test(row.credentialTypeCode) ||
    (row.evidenceRequirement !== "OPTIONAL" &&
      row.evidenceRequirement !== "REQUIRED") ||
    (row.state !== "PENDING" && row.state !== "APPROVED") ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !(row.createdAt instanceof Date) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.createdAt.valueOf()) ||
    !Number.isFinite(row.updatedAt.valueOf()) ||
    (row.profileType !== "INDIVIDUAL" && row.profileType !== "COMPANY") ||
    (row.primaryName !== null && row.primaryName.length === 0) ||
    (row.secondaryName !== null && row.secondaryName.length === 0) ||
    row.professionCode.length < 1 ||
    row.professionCode.length > 64 ||
    row.professionLabel.length < 1 ||
    row.professionLabel.length > 120
  ) {
    throw new Error("Invalid administrative credential-review projection.");
  }
  return Object.freeze({
    claimId: row.claimId,
    createdAt: new Date(row.createdAt),
    credentialTypeCode: row.credentialTypeCode,
    evidence,
    evidenceRequirement: row.evidenceRequirement,
    expiresOn: row.expiresOn,
    profession: Object.freeze({
      code: row.professionCode,
      id: row.professionId,
      label: row.professionLabel,
    }),
    profile: Object.freeze({
      id: row.profileId,
      primaryName: row.primaryName,
      profileType: row.profileType,
      secondaryName: row.secondaryName,
    }),
    revision: row.revision,
    state: row.state,
    updatedAt: new Date(row.updatedAt),
  });
}

function parseHistoryRow(row: ReviewRow): AdminCredentialReviewHistoryItem {
  const common = parseCommonRow(row);
  if (
    (row.state !== "APPROVED" &&
      row.state !== "REJECTED" &&
      row.state !== "REVOKED") ||
    !(row.reviewedAt instanceof Date) ||
    !Number.isFinite(row.reviewedAt.valueOf()) ||
    (row.state === "APPROVED"
      ? row.reviewReason !== null || row.reviewReasonCategory !== null
      : !validReviewReason(row.reviewReason, row.reviewReasonCategory))
  ) {
    throw new Error("Invalid administrative credential-review history.");
  }
  return Object.freeze({
    ...common,
    reviewReason: row.reviewReason,
    reviewReasonCategory:
      row.reviewReasonCategory as AdminCredentialReviewHistoryItem["reviewReasonCategory"],
    reviewedAt: new Date(row.reviewedAt),
    state: row.state,
  });
}

function parseCommonRow(row: ReviewRow) {
  const evidence = parseEvidence(row.evidence);
  if (
    !uuid.test(row.claimId) ||
    !uuid.test(row.profileId) ||
    !uuid.test(row.professionId) ||
    !credentialTypeCode.test(row.credentialTypeCode) ||
    (row.evidenceRequirement !== "OPTIONAL" &&
      row.evidenceRequirement !== "REQUIRED") ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !(row.createdAt instanceof Date) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.createdAt.valueOf()) ||
    !Number.isFinite(row.updatedAt.valueOf()) ||
    (row.profileType !== "INDIVIDUAL" && row.profileType !== "COMPANY") ||
    (row.primaryName !== null && row.primaryName.length === 0) ||
    (row.secondaryName !== null && row.secondaryName.length === 0) ||
    row.professionCode.length < 1 ||
    row.professionCode.length > 64 ||
    row.professionLabel.length < 1 ||
    row.professionLabel.length > 120
  ) {
    throw new Error("Invalid administrative credential-review projection.");
  }
  return {
    claimId: row.claimId,
    createdAt: new Date(row.createdAt),
    credentialTypeCode: row.credentialTypeCode,
    evidence,
    evidenceRequirement: row.evidenceRequirement,
    expiresOn: row.expiresOn,
    profession: Object.freeze({
      code: row.professionCode,
      id: row.professionId,
      label: row.professionLabel,
    }),
    profile: Object.freeze({
      id: row.profileId,
      primaryName: row.primaryName,
      profileType: row.profileType,
      secondaryName: row.secondaryName,
    }),
    revision: row.revision,
    updatedAt: new Date(row.updatedAt),
  } as const;
}

function parseEvidence(value: unknown): readonly AdminCredentialEvidenceItem[] {
  if (!Array.isArray(value))
    throw new Error("Invalid credential-review evidence projection.");
  const seen = new Set<string>();
  return Object.freeze(
    value.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !uuid.test(String((item as Record<string, unknown>)["assetId"])) ||
        !["DOCUMENT", "IMAGE"].includes(
          String((item as Record<string, unknown>)["mediaKind"]),
        ) ||
        !Number.isFinite(
          Date.parse(String((item as Record<string, unknown>)["attachedAt"])),
        )
      ) {
        throw new Error("Invalid credential-review evidence projection.");
      }
      const record = item as Record<string, unknown>;
      const assetId = String(record["assetId"]);
      if (seen.has(assetId))
        throw new Error("Duplicate credential-review evidence projection.");
      seen.add(assetId);
      return Object.freeze({
        assetId,
        attachedAt: new Date(String(record["attachedAt"])),
        mediaKind: record["mediaKind"] as "DOCUMENT" | "IMAGE",
      });
    }),
  );
}

function assertPageInput(input: {
  readonly cursor?: string;
  readonly limit: number;
}): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)
    throw new TypeError("Credential-review limit must be between 1 and 50.");
  if (input.cursor !== undefined && !uuid.test(input.cursor))
    throw new TypeError("Credential-review cursor is invalid.");
}

function assertReviewedState(
  state: AdminCredentialReviewHistoryItem["state"],
): void {
  if (state !== "APPROVED" && state !== "REJECTED" && state !== "REVOKED")
    throw new TypeError("Credential-review history state is invalid.");
}

function validReviewReason(
  reason: string | null,
  category: string | null,
): boolean {
  return (
    typeof reason === "string" &&
    reason === reason.trim() &&
    reason.length >= 8 &&
    reason.length <= 500 &&
    !/\p{Cc}/u.test(reason) &&
    (category === "EXPIRED_OR_INVALID" ||
      category === "FALSE_IDENTITY" ||
      category === "FALSE_QUALIFICATION" ||
      category === "INSUFFICIENT_EVIDENCE" ||
      category === "MISLEADING_CLAIM" ||
      category === "OTHER")
  );
}

function deniedAccess(assetId: string) {
  return createServerMediaEntityAccess({
    revision: `credential-denied:${assetId}`,
  });
}
