import { createHash, randomUUID } from "node:crypto";

import {
  JOB_INVITATION_DEFAULT_ACTIVE_LIMIT,
  JOB_INVITATION_DECLINE_REASONS,
  JOB_INVITATION_STATES,
  JobInvitationIdempotencyError,
  assertCloseJobInvitationInput,
  assertRespondToJobInvitationInput,
  assertSendJobInvitationInput,
  transitionJobInvitation,
  type CloseJobInvitationInput,
  type CraftsmanProfileId,
  type CustomerProfileId,
  type JobInvitation,
  type JobInvitationCommandResult,
  type JobInvitationDeclineReason,
  type JobInvitationId,
  type JobInvitationPersistence,
  type JobInvitationState,
  type JobRequestId,
  type RespondToJobInvitationInput,
  type SendJobInvitationInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type CommandKind =
  | "CRAFTSMAN_WITHDRAW"
  | "CUSTOMER_STOP"
  | "CUSTOMER_WITHDRAW"
  | "DECLINE"
  | "ENGAGE"
  | "EXPIRE"
  | "SEND";

interface CommandRow {
  readonly actorUserId: string | null;
  readonly commandKind: string;
  readonly declineNote: string | null;
  readonly declineReason: string | null;
  readonly invitationId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface InvitationRow {
  readonly changedAt: Date;
  readonly craftsmanProfileId: string;
  readonly customerProfileId: string;
  readonly declineNote: string | null;
  readonly declineReason: string | null;
  readonly engagedAt: Date | null;
  readonly expiresAt: Date;
  readonly id: string;
  readonly jobRequestId: string;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly sentAt: Date;
  readonly state: string;
}

export function createJobInvitationRepository(
  sql: Sql,
): JobInvitationPersistence {
  return Object.freeze({
    closeOwned(input: CloseJobInvitationInput) {
      assertCloseJobInvitationInput(input);
      return executeActorCommand(
        sql,
        input.action === "WITHDRAW" ? "CUSTOMER_WITHDRAW" : "CUSTOMER_STOP",
        input,
        null,
        null,
      );
    },
    async expirePending(): Promise<readonly JobInvitationId[]> {
      return sql.begin(async (transaction) => {
        const candidates = await transaction<
          Array<{
            readonly id: JobInvitationId;
            readonly revision: number;
          }>
        >`
          SELECT current.id, current.revision
          FROM current_job_invitations current
          JOIN job_invitations identity ON identity.id = current.id
          WHERE current.state = 'PENDING'
            AND current.expires_at <= clock_timestamp()
          ORDER BY current.expires_at, current.id
          LIMIT 100 FOR UPDATE OF identity SKIP LOCKED
        `;
        const expired: JobInvitationId[] = [];
        for (const candidate of candidates) {
          const commandId = randomUUID();
          const fingerprint = commandFingerprint("EXPIRE", {
            actorUserId: null,
            declineNote: null,
            declineReason: null,
            expectedRevision: candidate.revision,
            invitationId: candidate.id,
          });
          await insertCommand(transaction, {
            actorUserId: null,
            commandId,
            commandKind: "EXPIRE",
            declineNote: null,
            declineReason: null,
            expectedRevision: candidate.revision,
            fingerprint,
            invitationId: candidate.id,
            systemInitiated: true,
            targetState: "EXPIRED",
          });
          await insertRevision(transaction, {
            commandId,
            invitationId: candidate.id,
            revision: candidate.revision + 1,
            state: "EXPIRED",
          });
          expired.push(candidate.id);
        }
        return Object.freeze(expired);
      });
    },
    respondOwned(input: RespondToJobInvitationInput) {
      assertRespondToJobInvitationInput(input);
      return executeActorCommand(
        sql,
        input.action === "WITHDRAW" ? "CRAFTSMAN_WITHDRAW" : input.action,
        input,
        input.declineReason ?? null,
        input.declineNote ?? null,
      );
    },
    async sendOwned(
      input: SendJobInvitationInput,
    ): Promise<JobInvitationCommandResult> {
      assertSendJobInvitationInput(input);
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockVerifiedCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) return accountNotEligible();
        await lockCommand(transaction, input.commandId);
        const fingerprint = commandFingerprint("SEND", {
          actorUserId: input.actorUserId,
          craftsmanProfileId: input.craftsmanProfileId,
          jobRequestId: input.jobRequestId,
        });
        const replay = await replayCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "SEND",
          declineNote: null,
          declineReason: null,
          fingerprint,
        });
        if (replay !== null) return replay;
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(
            ${`${input.jobRequestId}:${input.craftsmanProfileId}`}, 41007
          ))
        `;
        const request = await lockActiveRequest(
          transaction,
          input.jobRequestId,
          customerProfileId,
        );
        if (request === null) return notFound();
        const existing = await transaction`
          SELECT id FROM job_invitations
          WHERE job_request_id = ${input.jobRequestId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
        `;
        if (existing.length > 0) {
          return Object.freeze({ status: "ALREADY_INVITED" as const });
        }
        if (
          !(await targetIsEligible(
            transaction,
            input.craftsmanProfileId,
            input.actorUserId,
            input.jobRequestId,
          ))
        ) {
          return Object.freeze({ status: "TARGET_NOT_ELIGIBLE" as const });
        }
        const policy = await lockInvitationLimit(
          transaction,
          input.jobRequestId,
        );
        if (policy.count >= policy.limit) {
          return Object.freeze({
            activeLimit: policy.limit,
            status: "ACTIVE_LIMIT_REACHED" as const,
          });
        }
        const invitationId = randomUUID() as JobInvitationId;
        await transaction`
          INSERT INTO job_invitations (
            id, job_request_id, customer_profile_id, craftsman_profile_id,
            request_content_revision, request_visible_version
          ) VALUES (
            ${invitationId}, ${input.jobRequestId}, ${customerProfileId},
            ${input.craftsmanProfileId}, ${request.contentRevision},
            ${request.visibleVersion}
          )
        `;
        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "SEND",
          declineNote: null,
          declineReason: null,
          expectedRevision: 0,
          fingerprint,
          invitationId,
          systemInitiated: false,
          targetState: "PENDING",
        });
        await insertRevision(transaction, {
          commandId: input.commandId,
          invitationId,
          revision: 1,
          state: "PENDING",
        });
        return applied(transaction, invitationId, 1);
      });
    },
  });
}

async function executeActorCommand(
  sql: Sql,
  kind: Exclude<CommandKind, "EXPIRE" | "SEND">,
  input: CloseJobInvitationInput | RespondToJobInvitationInput,
  declineReason: JobInvitationDeclineReason | null,
  declineNote: string | null,
): Promise<JobInvitationCommandResult> {
  return sql.begin(async (transaction) => {
    if (!(await actorIsVerified(transaction, input.actorUserId))) {
      return accountNotEligible();
    }
    await lockCommand(transaction, input.commandId);
    const fingerprint = commandFingerprint(kind, {
      actorUserId: input.actorUserId,
      declineNote,
      declineReason,
      expectedRevision: input.expectedRevision,
      invitationId: input.invitationId,
    });
    const replay = await replayCommand(transaction, {
      actorUserId: input.actorUserId,
      commandId: input.commandId,
      commandKind: kind,
      declineNote,
      declineReason,
      fingerprint,
    });
    if (replay !== null) return replay;
    const context = await lockInvitationContext(
      transaction,
      input.invitationId,
    );
    if (context === null) return notFound();
    const customerCommand =
      kind === "CUSTOMER_STOP" || kind === "CUSTOMER_WITHDRAW";
    if (
      (customerCommand && context.customerOwnerId !== input.actorUserId) ||
      (!customerCommand && context.craftsmanOwnerId !== input.actorUserId)
    ) {
      return notFound();
    }
    if (context.revision !== input.expectedRevision) {
      return Object.freeze({
        currentRevision: context.revision,
        status: "STALE_REVISION" as const,
      });
    }
    if (
      context.state === "PENDING" &&
      context.expiresAt.valueOf() <= context.databaseNow.valueOf()
    ) {
      return Object.freeze({ status: "INVALID_TRANSITION" as const });
    }
    const target = transitionJobInvitation(context.state, kind);
    if (target === null) {
      return Object.freeze({ status: "INVALID_TRANSITION" as const });
    }
    await insertCommand(transaction, {
      actorUserId: input.actorUserId,
      commandId: input.commandId,
      commandKind: kind,
      declineNote,
      declineReason,
      expectedRevision: input.expectedRevision,
      fingerprint,
      invitationId: input.invitationId,
      systemInitiated: false,
      targetState: target,
    });
    await insertRevision(transaction, {
      commandId: input.commandId,
      invitationId: input.invitationId,
      revision: input.expectedRevision + 1,
      state: target,
    });
    return applied(transaction, input.invitationId, input.expectedRevision + 1);
  });
}

async function lockVerifiedCustomer(sql: TransactionSql, actorUserId: UserId) {
  const [row] = await sql<{ readonly customerProfileId: string }[]>`
    SELECT customer.id AS "customerProfileId"
    FROM users actor
    JOIN auth_credentials credential ON credential.user_id = actor.id
    JOIN customer_profiles customer ON customer.owner_user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    FOR UPDATE OF actor, credential, customer
  `;
  return row === undefined
    ? null
    : (row.customerProfileId as CustomerProfileId);
}

async function actorIsVerified(sql: TransactionSql, actorUserId: UserId) {
  const rows = await sql`
    SELECT actor.id FROM users actor
    JOIN auth_credentials credential ON credential.user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    FOR UPDATE OF actor, credential
  `;
  return rows.length === 1;
}

async function lockActiveRequest(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  customerProfileId: CustomerProfileId,
) {
  const [row] = await sql<
    { readonly contentRevision: number; readonly visibleVersion: number }[]
  >`
    SELECT content.content_revision AS "contentRevision",
      content.visible_version AS "visibleVersion"
    FROM job_requests request
    JOIN current_job_requests current ON current.id = request.id
      AND current.state::text = 'ACTIVE'
    JOIN current_job_request_active_content_versions content
      ON content.job_request_id = request.id
    WHERE request.id = ${jobRequestId}
      AND request.customer_profile_id = ${customerProfileId}
    FOR UPDATE OF request
  `;
  return row ?? null;
}

async function targetIsEligible(
  sql: TransactionSql,
  profileId: CraftsmanProfileId,
  customerActorId: UserId,
  jobRequestId: JobRequestId,
) {
  const rows = await sql`
    SELECT publication.craftsman_profile_id
    FROM current_craftsman_profile_publications publication
    JOIN current_job_request_active_sections core
      ON core.job_request_id = ${jobRequestId}
     AND core.section_key = 'request.core'
    WHERE publication.craftsman_profile_id = ${profileId}
      AND publication.effectively_public
      AND publication.owner_user_id <> ${customerActorId}
      AND NOT EXISTS (
        SELECT 1 FROM current_credential_qualification_policies policy
        WHERE policy.profession_code = core.payload ->> 'primaryProfessionCode'
          AND policy.requirement = 'REQUIRED'
          AND NOT EXISTS (
            SELECT 1 FROM current_searchable_craftsman_credentials credential
            WHERE credential.craftsman_profile_id = ${profileId}
              AND credential.profession_code = policy.profession_code
              AND credential.credential_type_code = policy.credential_type_code
          )
      )
  `;
  return rows.length === 1;
}

async function lockInvitationLimit(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
) {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${jobRequestId}::text, 41007))
  `;
  const [row] = await sql<{ readonly count: number; readonly limit: number }[]>`
    SELECT policy.active_invitation_limit AS limit,
      count(current.id)::integer AS count
    FROM job_invitation_runtime_policy policy
    LEFT JOIN current_job_invitations current ON current.job_request_id = ${jobRequestId}
      AND current.state IN ('PENDING', 'ENGAGED')
    GROUP BY policy.active_invitation_limit
  `;
  if (row === undefined) throw new Error("Invitation runtime policy missing.");
  return row;
}

async function lockInvitationContext(
  sql: TransactionSql,
  invitationId: JobInvitationId,
) {
  const [row] = await sql<
    Array<{
      readonly craftsmanOwnerId: string;
      readonly customerOwnerId: string;
      readonly databaseNow: Date;
      readonly expiresAt: Date;
      readonly revision: number;
      readonly state: JobInvitationState;
    }>
  >`
    SELECT craftsman.owner_user_id AS "craftsmanOwnerId",
      customer.owner_user_id AS "customerOwnerId", current.revision,
      current.state, current.expires_at AS "expiresAt",
      clock_timestamp() AS "databaseNow"
    FROM job_invitations invitation
    JOIN current_job_invitations current ON current.id = invitation.id
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
    WHERE invitation.id = ${invitationId}
    FOR UPDATE OF invitation, customer, craftsman
  `;
  return row ?? null;
}

async function replayCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly commandKind: Exclude<CommandKind, "EXPIRE">;
    readonly declineNote: string | null;
    readonly declineReason: JobInvitationDeclineReason | null;
    readonly fingerprint: string;
  },
): Promise<JobInvitationCommandResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId", command_kind::text AS "commandKind",
      decline_note AS "declineNote", decline_reason::text AS "declineReason",
      invitation_id AS "invitationId", payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM job_invitation_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.commandKind !== input.commandKind ||
    row.declineNote !== input.declineNote ||
    row.declineReason !== input.declineReason ||
    row.payloadFingerprint !== input.fingerprint
  ) {
    throw new JobInvitationIdempotencyError(
      "Job invitation command id was reused for another intent.",
    );
  }
  const historical = await selectRevision(
    sql,
    row.invitationId as JobInvitationId,
    row.resultingRevision,
  );
  if (historical === null) throw new Error("Invitation replay effect missing.");
  return Object.freeze({
    invitation: historical,
    status: "DEDUPLICATED" as const,
  });
}

async function applied(
  sql: TransactionSql,
  invitationId: JobInvitationId,
  revision: number,
): Promise<JobInvitationCommandResult> {
  const result = await selectRevision(sql, invitationId, revision);
  if (result === null) throw new Error("Invitation command effect missing.");
  return Object.freeze({ invitation: result, status: "APPLIED" as const });
}

async function selectRevision(
  sql: TransactionSql,
  invitationId: JobInvitationId,
  revision: number,
): Promise<JobInvitation | null> {
  const [row] = await sql<InvitationRow[]>`
    SELECT invitation.id, invitation.job_request_id AS "jobRequestId",
      invitation.customer_profile_id AS "customerProfileId",
      invitation.craftsman_profile_id AS "craftsmanProfileId",
      invitation.request_content_revision AS "requestContentRevision",
      invitation.request_visible_version AS "requestVisibleVersion",
      stored.revision, stored.state::text AS state,
      stored.changed_at AS "changedAt", stored.sent_at AS "sentAt",
      stored.expires_at AS "expiresAt", stored.engaged_at AS "engagedAt",
      stored.decline_reason::text AS "declineReason",
      stored.decline_note AS "declineNote"
    FROM job_invitations invitation
    JOIN job_invitation_revisions stored ON stored.invitation_id = invitation.id
    WHERE invitation.id = ${invitationId} AND stored.revision = ${revision}
  `;
  return row === undefined ? null : toInvitation(row);
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId | null;
    readonly commandId: string;
    readonly commandKind: CommandKind;
    readonly declineNote: string | null;
    readonly declineReason: JobInvitationDeclineReason | null;
    readonly expectedRevision: number;
    readonly fingerprint: string;
    readonly invitationId: JobInvitationId;
    readonly systemInitiated: boolean;
    readonly targetState: JobInvitationState;
  },
) {
  await sql`
    INSERT INTO job_invitation_commands (
      command_id, invitation_id, actor_user_id, command_kind,
      expected_revision, resulting_revision, target_state, system_initiated,
      decline_reason, decline_note, payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.invitationId}, ${input.actorUserId},
      ${input.commandKind}, ${input.expectedRevision},
      ${input.expectedRevision + 1}, ${input.targetState},
      ${input.systemInitiated}, ${input.declineReason}, ${input.declineNote},
      ${input.fingerprint}
    )
  `;
}

async function insertRevision(
  sql: TransactionSql,
  input: {
    readonly commandId: string;
    readonly invitationId: JobInvitationId;
    readonly revision: number;
    readonly state: JobInvitationState;
  },
) {
  await sql`
    INSERT INTO job_invitation_revisions (
      invitation_id, revision, command_id, state, changed_at, sent_at,
      expires_at, engaged_at, decline_reason, decline_note
    ) VALUES (
      ${input.invitationId}, ${input.revision}, ${input.commandId},
      ${input.state}, clock_timestamp(), clock_timestamp(),
      clock_timestamp(), NULL, NULL, NULL
    )
  `;
}

function toInvitation(row: InvitationRow): JobInvitation {
  if (
    !JOB_INVITATION_STATES.some((state) => state === row.state) ||
    !(row.changedAt instanceof Date) ||
    !(row.sentAt instanceof Date) ||
    !(row.expiresAt instanceof Date) ||
    (row.engagedAt !== null && !(row.engagedAt instanceof Date)) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.requestContentRevision) ||
    row.requestContentRevision < 1 ||
    !Number.isSafeInteger(row.requestVisibleVersion) ||
    row.requestVisibleVersion < 1 ||
    !isUuid(row.id) ||
    !isUuid(row.jobRequestId) ||
    !isUuid(row.customerProfileId) ||
    !isUuid(row.craftsmanProfileId) ||
    (row.declineReason !== null &&
      !JOB_INVITATION_DECLINE_REASONS.some(
        (reason) => reason === row.declineReason,
      )) ||
    (row.declineNote !== null &&
      (row.declineNote !== row.declineNote.trim() ||
        row.declineNote.length < 1 ||
        row.declineNote.length > 500)) ||
    (row.state === "PENDING" && row.engagedAt !== null) ||
    (row.state === "ENGAGED" && row.engagedAt === null) ||
    ((row.state === "DECLINED" || row.state === "EXPIRED") &&
      row.engagedAt !== null) ||
    (row.state !== "DECLINED" &&
      (row.declineReason !== null || row.declineNote !== null))
  )
    throw new Error("Corrupt job invitation row.");
  return Object.freeze({
    changedAt: row.changedAt,
    craftsmanProfileId: row.craftsmanProfileId as CraftsmanProfileId,
    customerProfileId: row.customerProfileId as CustomerProfileId,
    declineNote: row.declineNote,
    declineReason: row.declineReason as JobInvitationDeclineReason | null,
    engagedAt: row.engagedAt,
    expiresAt: row.expiresAt,
    id: row.id as JobInvitationId,
    jobRequestId: row.jobRequestId as JobRequestId,
    requestContentRevision: row.requestContentRevision,
    requestVisibleVersion: row.requestVisibleVersion,
    revision: row.revision,
    sentAt: row.sentAt,
    state: row.state as JobInvitationState,
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

async function lockCommand(sql: TransactionSql, commandId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 41007))`;
}

function commandFingerprint(kind: CommandKind, input: object): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, ...input }), "utf8")
    .digest("hex");
}

function accountNotEligible(): JobInvitationCommandResult {
  return Object.freeze({ status: "ACCOUNT_NOT_ELIGIBLE" as const });
}

function notFound(): JobInvitationCommandResult {
  return Object.freeze({ status: "NOT_FOUND" as const });
}

export const JOB_INVITATION_RUNTIME_POLICY_DEFAULT = Object.freeze({
  activeLimit: JOB_INVITATION_DEFAULT_ACTIVE_LIMIT,
});
