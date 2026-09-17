import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobWorkLocation {
  readonly municipalityCode: string;
  readonly exactAddress: string | null;
  readonly mapPin: Readonly<{ latitude: number; longitude: number }> | null;
  readonly textClarification: string | null;
}

export interface ClarifyJobLocationInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly jobId: string;
  readonly location: JobWorkLocation;
  readonly reason: string;
}

export type ClarifyJobLocationResult =
  | Readonly<{
      recordedAt: Date;
      revision: number;
      status: "APPLIED" | "DEDUPLICATED";
    }>
  | Readonly<{
      status: "NOT_CLARIFICATION" | "NOT_FOUND" | "STALE_REVISION";
    }>;

export class JobLocationIdempotencyError extends Error {}

interface ExistingCommand {
  readonly actorUserId: string;
  readonly expectedRevision: number;
  readonly jobId: string;
  readonly payloadFingerprint: string;
  readonly recordedAt: Date;
}

interface CurrentLocation {
  readonly locationPayload: unknown;
  readonly revision: number;
}

export function createJobLocationClarificationRepository(sql: RootSql) {
  return Object.freeze({
    clarify(input: ClarifyJobLocationInput): Promise<ClarifyJobLocationResult> {
      const location = validateInput(input);
      const reason = input.reason.trim();
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            actorUserId: input.actorUserId,
            expectedRevision: input.expectedRevision,
            jobId: input.jobId,
            location,
            reason,
          }),
        )
        .digest("hex");
      return transaction(sql, async (tx) => {
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${input.commandId}::text, 51004)
          )
        `;
        const [owned] = await tx<Array<{ id: string }>>`
          SELECT job.id FROM jobs job
          JOIN customer_profiles customer
            ON customer.id = job.customer_profile_id
          WHERE job.id = ${input.jobId}
            AND customer.owner_user_id = ${input.actorUserId}
            AND job.initial_state = 'CONFIRMED'
        `;
        if (owned === undefined) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
        await tx`
          SELECT id FROM users WHERE id = ${input.actorUserId} FOR SHARE
        `;
        await tx`
          SELECT user_id FROM auth_credentials
          WHERE user_id = ${input.actorUserId} FOR SHARE
        `;
        const [eligible] = await tx<Array<{ id: string }>>`
          SELECT job.id FROM jobs job
          JOIN customer_profiles customer
            ON customer.id = job.customer_profile_id
          JOIN users actor ON actor.id = customer.owner_user_id
          JOIN auth_credentials credentials ON credentials.user_id = actor.id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_system_timeline_events unlocked
            ON unlocked.job_id = job.id
            AND unlocked.source_acceptance_event_id = accepted.event_id
            AND unlocked.event_type = 'CONTACT_ADDRESS_UNLOCKED'
          WHERE job.id = ${input.jobId}
            AND actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
            AND credentials.email_verified_at IS NOT NULL
            AND credentials.phone_verified_at IS NOT NULL
        `;
        if (eligible === undefined) return { status: "NOT_FOUND" };
        const [existing] = await tx<ExistingCommand[]>`
          SELECT job_id AS "jobId", actor_user_id AS "actorUserId",
            expected_revision AS "expectedRevision",
            payload_fingerprint AS "payloadFingerprint",
            recorded_at AS "recordedAt"
          FROM job_location_clarification_commands
          WHERE command_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.jobId !== input.jobId ||
            existing.expectedRevision !== input.expectedRevision ||
            existing.payloadFingerprint !== fingerprint
          )
            throw new JobLocationIdempotencyError(
              "Job location command id was reused for another intent.",
            );
          return Object.freeze({
            recordedAt: existing.recordedAt,
            revision: existing.expectedRevision + 1,
            status: "DEDUPLICATED" as const,
          });
        }
        const [current] = await tx<CurrentLocation[]>`
          SELECT revision, location_payload AS "locationPayload"
          FROM current_job_locations WHERE job_id = ${input.jobId}
        `;
        if (current === undefined) return { status: "NOT_FOUND" };
        if (current.revision !== input.expectedRevision)
          return { status: "STALE_REVISION" };
        if (!isAdditiveClarification(current.locationPayload, location))
          return { status: "NOT_CLARIFICATION" };
        const [inserted] = await tx<Array<{ recordedAt: Date }>>`
          INSERT INTO job_location_clarification_commands (
            command_id, job_id, actor_user_id, expected_revision,
            location_payload, reason, payload_fingerprint
          ) VALUES (
            ${input.commandId}, ${input.jobId}, ${input.actorUserId},
            ${input.expectedRevision}, ${tx.json(location as never)}, ${reason},
            ${fingerprint}
          ) RETURNING recorded_at AS "recordedAt"
        `;
        if (inserted === undefined)
          throw new Error("Job location clarification effect missing.");
        return Object.freeze({
          recordedAt: inserted.recordedAt,
          revision: input.expectedRevision + 1,
          status: "APPLIED" as const,
        });
      });
    },
  });
}

function validateInput(input: ClarifyJobLocationInput): JobWorkLocation {
  if (
    !uuid.test(input.actorUserId) ||
    !uuid.test(input.commandId) ||
    !uuid.test(input.jobId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 8 ||
    input.reason.trim().length > 500
  )
    throw new TypeError("Invalid Job location clarification command.");
  const location = input.location;
  if (
    typeof location !== "object" ||
    location === null ||
    Object.keys(location).sort().join(",") !==
      "exactAddress,mapPin,municipalityCode,textClarification" ||
    typeof location.municipalityCode !== "string" ||
    location.municipalityCode.trim().length === 0 ||
    !validOptionalText(location.exactAddress, 500) ||
    !validOptionalText(location.textClarification, 1000)
  )
    throw new TypeError("Invalid Job work location.");
  const pin = location.mapPin;
  if (
    pin !== null &&
    (typeof pin !== "object" ||
      Object.keys(pin).sort().join(",") !== "latitude,longitude" ||
      !Number.isFinite(pin.latitude) ||
      !Number.isFinite(pin.longitude) ||
      pin.latitude < -90 ||
      pin.latitude > 90 ||
      pin.longitude < -180 ||
      pin.longitude > 180)
  )
    throw new TypeError("Invalid Job work map pin.");
  return Object.freeze({
    exactAddress: location.exactAddress,
    mapPin:
      pin === null
        ? null
        : Object.freeze({ latitude: pin.latitude, longitude: pin.longitude }),
    municipalityCode: location.municipalityCode,
    textClarification: location.textClarification,
  });
}

function validOptionalText(value: unknown, max: number): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      value.trim().length >= 1 &&
      value.trim().length <= max)
  );
}

function isAdditiveClarification(
  currentValue: unknown,
  proposed: JobWorkLocation,
): boolean {
  if (typeof currentValue !== "object" || currentValue === null) return false;
  const current = currentValue as Record<string, unknown>;
  if (current["municipalityCode"] !== proposed.municipalityCode) return false;
  let changed = false;
  for (const field of ["exactAddress", "textClarification"] as const) {
    const prior = current[field] ?? null;
    if (prior !== null && prior !== proposed[field]) return false;
    if (prior !== proposed[field]) changed = true;
  }
  const oldPin = current["mapPin"];
  if (oldPin !== null && oldPin !== undefined) {
    if (
      typeof oldPin !== "object" ||
      (oldPin as Record<string, unknown>)["latitude"] !==
        proposed.mapPin?.latitude ||
      (oldPin as Record<string, unknown>)["longitude"] !==
        proposed.mapPin?.longitude
    )
      return false;
  } else if (proposed.mapPin !== null) {
    changed = true;
  }
  return changed;
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
