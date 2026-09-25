import type { UserId } from "@portal/domain";
import {
  JOB_PROPERTY_PHOTO_CONSENT_ACTION_VALUES,
  type JobPropertyPhotoConsentAction,
} from "@portal/privacy";
import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PropertyPhotoConsentPolicy {
  readonly contentSha256: string;
  readonly policyVersionId: string;
  readonly versionLabel: string;
}

export interface JobPropertyPhotoConsentItem {
  readonly action: JobPropertyPhotoConsentAction | null;
  readonly mediaAssetId: string;
  readonly occurredAt: Date | null;
  readonly policyVersionId: string | null;
  readonly revision: number;
}

export interface JobPropertyPhotoConsentEvent {
  readonly action: JobPropertyPhotoConsentAction;
  readonly correlationId: string;
  readonly customerUserId: UserId;
  readonly eventId: string;
  readonly jobId: string;
  readonly mediaAssetId: string;
  readonly occurredAt: Date;
  readonly policyVersionId: string;
  readonly revision: number;
}

export interface AppendJobPropertyPhotoConsentInput {
  readonly action: JobPropertyPhotoConsentAction;
  readonly correlationId: string;
  readonly customerUserId: UserId;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly jobId: string;
  readonly mediaAssetId: string;
  readonly policyVersionId: string;
}

export type AppendJobPropertyPhotoConsentResult =
  | Readonly<{
      readonly event: JobPropertyPhotoConsentEvent;
      readonly status: "APPENDED" | "DEDUPLICATED";
    }>
  | Readonly<{ readonly status: "NOT_FOUND" }>
  | Readonly<{ readonly status: "POLICY_NOT_APPROVED" }>
  | Readonly<{ readonly currentRevision: number; readonly status: "STALE" }>
  | Readonly<{
      readonly currentRevision: number;
      readonly status: "UNCHANGED";
    }>;

type ConsentRow = JobPropertyPhotoConsentEvent;

export class JobPropertyPhotoConsentIdempotencyError extends Error {}

export function createJobPropertyPhotoConsentRepository(sql: RootSql) {
  async function listForCustomerJob(input: {
    readonly customerUserId: UserId;
    readonly jobId: string;
  }): Promise<Readonly<{
    readonly items: readonly JobPropertyPhotoConsentItem[];
    readonly policy: PropertyPhotoConsentPolicy | null;
  }> | null> {
    id(input.customerUserId);
    id(input.jobId);
    return transaction(sql, async (tx) => {
      const [authorized] = await tx<Array<{ readonly allowed: boolean }>>`
        SELECT true AS allowed
        FROM jobs job
        JOIN customer_profiles customer ON customer.id = job.customer_profile_id
        WHERE job.id = ${input.jobId}
          AND customer.owner_user_id = ${input.customerUserId}`;
      if (authorized?.allowed !== true) return null;
      const rows = await tx<JobPropertyPhotoConsentItem[]>`
        SELECT DISTINCT job_media.media_asset_id AS "mediaAssetId",
          consent.action::text, COALESCE(consent.revision, 0)::integer AS revision,
          consent.policy_version_id AS "policyVersionId",
          consent.occurred_at AS "occurredAt"
        FROM job_conversation_media job_media
        JOIN media_assets asset ON asset.id = job_media.media_asset_id
          AND asset.kind = 'IMAGE' AND asset.status = 'READY'
        JOIN media_asset_storage_objects canonical
          ON canonical.media_asset_id = asset.id
          AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private'
          AND canonical.revoked_at IS NULL
          AND canonical.content_sha256 IS NOT NULL
        LEFT JOIN current_job_property_photo_consents consent
          ON consent.job_id = job_media.job_id
          AND consent.media_asset_id = job_media.media_asset_id
        WHERE job_media.job_id = ${input.jobId}
          AND job_media.media_kind = 'IMAGE'
        ORDER BY job_media.media_asset_id`;
      const [policy] = await tx<PropertyPhotoConsentPolicy[]>`
        SELECT policy_version_id AS "policyVersionId",
          version_label AS "versionLabel", content_sha256 AS "contentSha256"
        FROM privacy_policy_versions
        WHERE policy_kind = 'OPTIONAL_CONSENT_TEXT'
          AND optional_consent_purpose =
            'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION'
          AND review_state = 'APPROVED'
          AND effective_at <= CURRENT_TIMESTAMP
        ORDER BY effective_at DESC, created_at DESC, policy_version_id DESC
        LIMIT 1`;
      return Object.freeze({
        items: freezeRows(rows),
        policy: policy === undefined ? null : Object.freeze({ ...policy }),
      });
    });
  }

  async function appendDecision(
    input: AppendJobPropertyPhotoConsentInput,
  ): Promise<AppendJobPropertyPhotoConsentResult> {
    validate(input);
    return transaction(sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(
        hashtextextended(${`${input.jobId}:${input.mediaAssetId}`}, 427_109)
      )`;
      const [existing] = await tx<ConsentRow[]>`
        SELECT event_id AS "eventId", correlation_id AS "correlationId",
          job_id AS "jobId", media_asset_id AS "mediaAssetId",
          customer_user_id AS "customerUserId", action::text,
          policy_version_id AS "policyVersionId", revision,
          occurred_at AS "occurredAt"
        FROM job_property_photo_consent_events
        WHERE event_id = ${input.eventId}`;
      if (existing !== undefined) {
        if (!same(existing, input))
          throw new JobPropertyPhotoConsentIdempotencyError(
            "Property-photo consent event ID was reused with another intent.",
          );
        return Object.freeze({
          event: freezeEvent(existing),
          status: "DEDUPLICATED" as const,
        });
      }
      const [scope] = await tx<
        Array<{
          readonly action: JobPropertyPhotoConsentAction | null;
          readonly policyVersionId: string | null;
          readonly revision: number;
        }>
      >`
        SELECT consent.action::text,
          consent.policy_version_id AS "policyVersionId",
          COALESCE(consent.revision, 0)::integer AS revision
        FROM jobs job
        JOIN customer_profiles customer ON customer.id = job.customer_profile_id
        JOIN users actor ON actor.id = customer.owner_user_id
        JOIN job_conversation_media job_media ON job_media.job_id = job.id
          AND job_media.media_asset_id = ${input.mediaAssetId}
          AND job_media.media_kind = 'IMAGE'
        JOIN media_assets asset ON asset.id = job_media.media_asset_id
          AND asset.kind = 'IMAGE' AND asset.status = 'READY'
        JOIN media_asset_storage_objects canonical
          ON canonical.media_asset_id = asset.id
          AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private'
          AND canonical.revoked_at IS NULL
          AND canonical.content_sha256 IS NOT NULL
        LEFT JOIN current_job_property_photo_consents consent
          ON consent.job_id = job.id
          AND consent.media_asset_id = job_media.media_asset_id
        WHERE job.id = ${input.jobId}
          AND customer.owner_user_id = ${input.customerUserId}
          AND (
            (actor.account_state = 'ACTIVE')
            OR (${input.action} = 'WITHDRAWN' AND actor.account_state = 'SUSPENDED')
          )`;
      if (scope === undefined) return { status: "NOT_FOUND" };
      if (scope.revision !== input.expectedRevision)
        return { currentRevision: scope.revision, status: "STALE" };
      if (
        scope.action === input.action ||
        (input.action === "WITHDRAWN" && scope.action !== "GRANTED")
      )
        return { currentRevision: scope.revision, status: "UNCHANGED" };
      if (scope.action === "GRANTED" && input.action === "DECLINED")
        throw new TypeError("A current grant must be withdrawn.");

      if (input.action === "WITHDRAWN") {
        if (scope.policyVersionId !== input.policyVersionId)
          return { status: "POLICY_NOT_APPROVED" };
      } else {
        const [policy] = await tx<Array<{ readonly approved: boolean }>>`
          SELECT true AS approved
          FROM privacy_policy_versions
          WHERE policy_version_id = ${input.policyVersionId}
            AND policy_kind = 'OPTIONAL_CONSENT_TEXT'
            AND optional_consent_purpose =
              'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION'
            AND review_state = 'APPROVED'
            AND effective_at <= CURRENT_TIMESTAMP`;
        if (policy?.approved !== true) return { status: "POLICY_NOT_APPROVED" };
      }

      const [inserted] = await tx<ConsentRow[]>`
        INSERT INTO job_property_photo_consent_events (
          event_id, correlation_id, job_id, media_asset_id,
          customer_user_id, actor_user_id, action,
          policy_version_id, revision
        ) VALUES (
          ${input.eventId}, ${input.correlationId}, ${input.jobId},
          ${input.mediaAssetId}, ${input.customerUserId},
          ${input.customerUserId}, ${input.action},
          ${input.policyVersionId}, ${scope.revision + 1}
        ) RETURNING event_id AS "eventId",
          correlation_id AS "correlationId", job_id AS "jobId",
          media_asset_id AS "mediaAssetId",
          customer_user_id AS "customerUserId", action::text,
          policy_version_id AS "policyVersionId", revision,
          occurred_at AS "occurredAt"`;
      if (inserted === undefined)
        throw new Error("Property-photo consent effect missing.");
      return Object.freeze({
        event: freezeEvent(inserted),
        status: "APPENDED" as const,
      });
    });
  }

  return Object.freeze({ appendDecision, listForCustomerJob });
}

function validate(input: AppendJobPropertyPhotoConsentInput): void {
  for (const value of [
    input.correlationId,
    input.customerUserId,
    input.eventId,
    input.jobId,
    input.mediaAssetId,
    input.policyVersionId,
  ])
    id(value);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !JOB_PROPERTY_PHOTO_CONSENT_ACTION_VALUES.includes(input.action)
  )
    throw new TypeError("Invalid property-photo consent decision.");
}
function same(
  row: ConsentRow,
  input: AppendJobPropertyPhotoConsentInput,
): boolean {
  return (
    row.action === input.action &&
    row.correlationId === input.correlationId &&
    row.customerUserId === input.customerUserId &&
    row.jobId === input.jobId &&
    row.mediaAssetId === input.mediaAssetId &&
    row.policyVersionId === input.policyVersionId &&
    row.revision === input.expectedRevision + 1
  );
}
function freezeEvent(row: ConsentRow): JobPropertyPhotoConsentEvent {
  return Object.freeze({ ...row });
}
function freezeRows<T extends object>(rows: readonly T[]) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}
function id(value: string): void {
  if (!uuid.test(value)) throw new TypeError("Invalid identity.");
}
function transaction<T>(
  sql: RootSql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(work)
    : sql.begin(work)) as unknown as Promise<T>;
}
