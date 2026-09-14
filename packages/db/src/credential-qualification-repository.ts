import {
  assertCredentialQualificationInput,
  assertPreparedCredentialQualificationPolicyRelease,
  type CredentialQualificationInput,
  type CredentialQualificationPolicyActivationInput,
  type CredentialQualificationPolicyPersistence,
  type CredentialQualificationRow,
  type PreparedCredentialQualificationPolicyRelease,
} from "@portal/search";
import type { Sql, TransactionSql } from "postgres";

interface StoredReleaseRow {
  readonly checksumSha256: string;
  readonly contentClass: string;
  readonly releaseId: string;
  readonly reviewReference: string | null;
  readonly reviewState: string;
  readonly supersedesReleaseId: string | null;
  readonly taxonomyReleaseId: string;
  readonly version: number;
}

interface StoredEntryRow {
  readonly credentialTypeCode: string;
  readonly professionCode: string;
  readonly requirement: string;
}

interface StoredActivationRow {
  readonly actorReference: string;
  readonly previousReleaseId: string | null;
  readonly releaseId: string;
  readonly reviewReference: string;
}

export function createCredentialQualificationRepository(
  sql: Sql,
): CredentialQualificationPolicyPersistence {
  return Object.freeze({
    async activateRelease(
      input: CredentialQualificationPolicyActivationInput,
    ): Promise<boolean> {
      const rows = await sql<{ readonly activationId: string }[]>`
        INSERT INTO credential_qualification_policy_activation_events (
          activation_id, release_id, previous_release_id,
          actor_reference, review_reference
        ) VALUES (
          ${input.activationId}, ${input.releaseId}, ${input.previousReleaseId},
          ${input.actorReference}, ${input.reviewReference}
        )
        ON CONFLICT (activation_id) DO NOTHING
        RETURNING activation_id AS "activationId"
      `;
      if (rows.length === 1) return true;
      const stored = await sql<StoredActivationRow[]>`
        SELECT release_id AS "releaseId",
          previous_release_id AS "previousReleaseId",
          actor_reference AS "actorReference",
          review_reference AS "reviewReference"
        FROM credential_qualification_policy_activation_events
        WHERE activation_id = ${input.activationId}
      `;
      const replay = stored[0];
      if (
        stored.length === 1 &&
        replay !== undefined &&
        replay.releaseId === input.releaseId &&
        replay.previousReleaseId === input.previousReleaseId &&
        replay.actorReference === input.actorReference &&
        replay.reviewReference === input.reviewReference
      ) {
        return false;
      }
      throw new Error(
        "Credential qualification activation conflicts with existing provenance.",
      );
    },

    async evaluate(
      input: CredentialQualificationInput,
    ): Promise<CredentialQualificationRow | null> {
      assertCredentialQualificationInput(input);
      const rows = await sql<CredentialQualificationRow[]>`
        SELECT eligibility, requirement,
          current_approved AS "currentApproved", reason_code AS "reasonCode"
        FROM evaluate_craftsman_credential_qualification(
          ${input.craftsmanProfileId},
          ${input.professionCode},
          ${input.credentialTypeCode}
        )
      `;
      const row = rows.length === 1 ? rows[0] : undefined;
      return row === undefined
        ? null
        : Object.freeze({
            currentApproved: row.currentApproved,
            eligibility: row.eligibility,
            reasonCode: row.reasonCode,
            requirement: row.requirement,
          });
    },

    async installRelease(
      release: PreparedCredentialQualificationPolicyRelease,
    ): Promise<"CREATED" | "UNCHANGED"> {
      // Never trust a caller-supplied digest. Recompute over the canonical,
      // fully ordered release before opening the transaction.
      assertPreparedCredentialQualificationPolicyRelease(release);
      return sql.begin(async (transaction) => {
        const created = await transaction<{ readonly releaseId: string }[]>`
          INSERT INTO credential_qualification_policy_releases (
            release_id, version, taxonomy_release_id, content_class,
            review_state, review_reference, supersedes_release_id,
            checksum_sha256
          ) VALUES (
            ${release.releaseId}, ${release.version}, ${release.taxonomyReleaseId},
            ${release.contentClass}, ${release.reviewState},
            ${release.reviewReference}, ${release.supersedesReleaseId},
            ${release.checksumSha256}
          )
          ON CONFLICT DO NOTHING
          RETURNING release_id AS "releaseId"
        `;
        if (created.length === 1) {
          await insertEntries(transaction, release);
        }
        await assertStoredRelease(transaction, release);
        return created.length === 1 ? "CREATED" : "UNCHANGED";
      });
    },
  });
}

async function insertEntries(
  sql: TransactionSql,
  release: PreparedCredentialQualificationPolicyRelease,
): Promise<void> {
  for (const entry of release.entries) {
    await sql`
      INSERT INTO credential_qualification_policy_entries (
        release_id, taxonomy_release_id, profession_code,
        credential_type_code, requirement
      ) VALUES (
        ${release.releaseId}, ${release.taxonomyReleaseId},
        ${entry.professionCode}, ${entry.credentialTypeCode},
        ${entry.requirement}
      )
    `;
  }
}

async function assertStoredRelease(
  sql: TransactionSql,
  release: PreparedCredentialQualificationPolicyRelease,
): Promise<void> {
  const headers = await sql<StoredReleaseRow[]>`
    SELECT release_id AS "releaseId", version,
      taxonomy_release_id AS "taxonomyReleaseId",
      content_class AS "contentClass", review_state AS "reviewState",
      review_reference AS "reviewReference",
      supersedes_release_id AS "supersedesReleaseId",
      checksum_sha256 AS "checksumSha256"
    FROM credential_qualification_policy_releases
    WHERE version = ${release.version}
  `;
  const entries = await sql<StoredEntryRow[]>`
    SELECT profession_code AS "professionCode",
      credential_type_code AS "credentialTypeCode", requirement
    FROM credential_qualification_policy_entries
    WHERE release_id = ${release.releaseId}
    ORDER BY profession_code, credential_type_code
  `;
  const header = headers[0];
  if (
    headers.length !== 1 ||
    header === undefined ||
    header.releaseId !== release.releaseId ||
    header.version !== release.version ||
    header.taxonomyReleaseId !== release.taxonomyReleaseId ||
    header.contentClass !== release.contentClass ||
    header.reviewState !== release.reviewState ||
    header.reviewReference !== release.reviewReference ||
    header.supersedesReleaseId !== release.supersedesReleaseId ||
    header.checksumSha256 !== release.checksumSha256 ||
    JSON.stringify(entries) !== JSON.stringify(release.entries)
  ) {
    throw new Error(
      "Existing credential qualification policy conflicts with the governed release.",
    );
  }
}
