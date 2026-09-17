import { createHash, randomUUID } from "node:crypto";

import {
  assertQuoteAcceptanceCommandInput,
  QuoteAcceptanceIdempotencyError,
  type JobId,
  type QuoteAcceptanceCommandInput,
  type QuoteAcceptanceCommandResult,
  type QuoteAcceptancePersistence,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

import { createJobLocationClarificationRepository } from "./job-location-clarification-repository.js";

type RootSql = Sql | TransactionSql;

class FinalAddressConflictError extends Error {}

interface AcceptanceSource {
  readonly authoringEligible: boolean;
  readonly contentRevision: number;
  readonly customerProfileId: string;
  readonly databaseNow: Date;
  readonly deadlinePassed: boolean;
  readonly invitationId: string;
  readonly invitationState: string;
  readonly lifecycleEligible: boolean;
  readonly primaryProfessionCode: string | null;
  readonly providerAccountState: string;
  readonly providerEmailVerified: boolean;
  readonly providerPhoneVerified: boolean;
  readonly providerProfileId: string;
  readonly quoteRevision: number;
  readonly quoteState: string;
  readonly quoteStateRevision: number;
  readonly requestExpiresAt: Date | null;
  readonly requestState: string;
  readonly requestVisibleVersion: number;
  readonly visibleVersion: number;
  readonly winningConversationId: string;
}

interface ExistingJob {
  readonly acceptedAt: Date;
  readonly acceptedByUserId: string;
  readonly acceptedQuoteId: string;
  readonly acceptedQuoteRevision: number;
  readonly acceptancePayloadFingerprint: string;
  readonly id: string;
  readonly jobRequestId: string;
}

export function createQuoteAcceptanceRepository(
  sql: RootSql,
): QuoteAcceptancePersistence {
  return Object.freeze({
    accept(input: QuoteAcceptanceCommandInput) {
      assertQuoteAcceptanceCommandInput(input);
      return accept(sql, input).catch((error: unknown) => {
        if (error instanceof FinalAddressConflictError)
          return { status: "NOT_ACCEPTABLE" as const };
        throw error;
      });
    },
  });
}

async function accept(
  sql: RootSql,
  input: QuoteAcceptanceCommandInput,
): Promise<QuoteAcceptanceCommandResult> {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId: input.actorUserId,
        explicitlyConfirmed: input.explicitlyConfirmed,
        expectedQuoteStateRevision: input.expectedQuoteStateRevision,
        expectedRequestContentRevision: input.expectedRequestContentRevision,
        expectedRequestVisibleVersion: input.expectedRequestVisibleVersion,
        ...(input.finalExactAddress === undefined
          ? {}
          : { finalExactAddress: input.finalExactAddress }),
        jobRequestId: input.jobRequestId,
        quoteId: input.quoteId,
        quoteRevision: input.quoteRevision,
      }),
    )
    .digest("hex");
  return transaction(sql, async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${input.commandId}::text, 51002)
      )
    `;
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${input.jobRequestId}::text, 41007)
      )
    `;

    const [ownedActor] = await tx<Array<{ id: string }>>`
      SELECT actor.id FROM users actor
      JOIN auth_credentials credentials ON credentials.user_id = actor.id
      JOIN customer_profiles customer ON customer.owner_user_id = actor.id
      JOIN job_requests request ON request.customer_profile_id = customer.id
      WHERE actor.id = ${input.actorUserId}
        AND request.id = ${input.jobRequestId}
        AND actor.account_state = 'ACTIVE'
        AND credentials.email_verified_at IS NOT NULL
        AND credentials.phone_verified_at IS NOT NULL
    `;
    if (ownedActor === undefined) return { status: "NOT_FOUND" };

    const [participantOwners] = await tx<Array<{ providerOwnerId: string }>>`
      SELECT craftsman.owner_user_id AS "providerOwnerId"
      FROM quotes quote
      JOIN job_invitations invitation ON invitation.id = quote.invitation_id
      JOIN craftsman_profiles craftsman
        ON craftsman.id = invitation.craftsman_profile_id
      WHERE quote.id = ${input.quoteId}
        AND invitation.job_request_id = ${input.jobRequestId}
    `;
    if (participantOwners === undefined) return { status: "NOT_FOUND" };
    await tx`
      SELECT id FROM users
      WHERE id IN (${input.actorUserId}, ${participantOwners.providerOwnerId})
      ORDER BY id FOR UPDATE
    `;
    await tx`
      SELECT user_id FROM auth_credentials
      WHERE user_id IN (${input.actorUserId}, ${participantOwners.providerOwnerId})
      ORDER BY user_id FOR UPDATE
    `;
    const [currentlyActiveActor] = await tx<Array<{ id: string }>>`
      SELECT actor.id FROM users actor
      JOIN auth_credentials credentials ON credentials.user_id = actor.id
      WHERE actor.id = ${input.actorUserId}
        AND actor.account_state = 'ACTIVE'
        AND credentials.email_verified_at IS NOT NULL
        AND credentials.phone_verified_at IS NOT NULL
    `;
    if (currentlyActiveActor === undefined) return { status: "NOT_FOUND" };

    const [existing] = await tx<ExistingJob[]>`
      SELECT id, job_request_id AS "jobRequestId",
        accepted_quote_id AS "acceptedQuoteId",
        accepted_quote_revision AS "acceptedQuoteRevision",
        accepted_by_user_id AS "acceptedByUserId",
        acceptance_payload_fingerprint AS "acceptancePayloadFingerprint",
        accepted_at AS "acceptedAt"
      FROM jobs WHERE acceptance_command_id = ${input.commandId}
    `;
    if (existing !== undefined) {
      if (existing.acceptedByUserId !== input.actorUserId)
        return { status: "NOT_FOUND" };
      if (
        existing.jobRequestId !== input.jobRequestId ||
        existing.acceptedQuoteId !== input.quoteId ||
        existing.acceptedQuoteRevision !== input.quoteRevision ||
        existing.acceptancePayloadFingerprint !== fingerprint
      )
        throw new QuoteAcceptanceIdempotencyError(
          "Quote acceptance command id was reused for another intent.",
        );
      return Object.freeze({
        acceptedAt: existing.acceptedAt,
        jobId: existing.id as JobId,
        status: "DEDUPLICATED" as const,
      });
    }
    const [otherJob] = await tx<Array<{ id: string }>>`
      SELECT id FROM jobs WHERE job_request_id = ${input.jobRequestId}
    `;
    if (otherJob !== undefined) return { status: "NOT_ACCEPTABLE" };

    const [source] = await tx<AcceptanceSource[]>`
      SELECT request.state::text AS "requestState",
        request.expires_at AS "requestExpiresAt",
        invitation.id AS "invitationId",
        current_invitation.state::text AS "invitationState",
        conversation.id AS "winningConversationId",
        craftsman.id AS "providerProfileId",
        craftsman_owner.account_state::text AS "providerAccountState",
        craftsman_auth.email_verified_at IS NOT NULL AS "providerEmailVerified",
        craftsman_auth.phone_verified_at IS NOT NULL AS "providerPhoneVerified",
        customer.id AS "customerProfileId",
        context.quote_revision AS "quoteRevision",
        context.state::text AS "quoteState",
        context.state_revision AS "quoteStateRevision",
        context.request_content_revision AS "contentRevision",
        context.request_visible_version AS "visibleVersion",
        context.current_request_visible_version AS "requestVisibleVersion",
        context.authoring_eligible AS "authoringEligible",
        context.deadline_passed AS "deadlinePassed",
        context.lifecycle_acceptance_eligible AS "lifecycleEligible",
        clock_timestamp() AS "databaseNow",
        request_core.payload ->> 'primaryProfessionCode'
          AS "primaryProfessionCode"
      FROM quotes quote
      JOIN job_invitations invitation ON invitation.id = quote.invitation_id
      JOIN current_job_invitations current_invitation
        ON current_invitation.id = invitation.id
      JOIN conversations conversation ON conversation.id = quote.conversation_id
        AND conversation.invitation_id = invitation.id
      JOIN current_job_requests request ON request.id = invitation.job_request_id
      JOIN customer_profiles customer ON customer.id = request.customer_profile_id
        AND customer.id = invitation.customer_profile_id
      JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
      JOIN users craftsman_owner ON craftsman_owner.id = craftsman.owner_user_id
      JOIN auth_credentials craftsman_auth
        ON craftsman_auth.user_id = craftsman_owner.id
      JOIN current_quote_acceptance_context context
        ON context.quote_id = quote.id
        AND context.quote_revision = ${input.quoteRevision}
      LEFT JOIN LATERAL (
        SELECT section.payload
        FROM job_request_active_section_revisions section
        WHERE section.job_request_id = request.id
          AND section.section_key = 'request.core'
          AND section.content_revision <= context.request_content_revision
        ORDER BY section.content_revision DESC LIMIT 1
      ) request_core ON true
      WHERE quote.id = ${input.quoteId}
        AND request.id = ${input.jobRequestId}
        AND customer.owner_user_id = ${input.actorUserId}
    `;
    if (source === undefined) return { status: "NOT_FOUND" };
    if (
      source.quoteRevision !== input.quoteRevision ||
      source.quoteStateRevision !== input.expectedQuoteStateRevision ||
      source.contentRevision !== input.expectedRequestContentRevision ||
      source.visibleVersion !== input.expectedRequestVisibleVersion ||
      source.requestVisibleVersion !== input.expectedRequestVisibleVersion
    )
      return { status: "STALE_REVISION" };
    if (
      source.requestState !== "ACTIVE" ||
      source.requestExpiresAt === null ||
      source.requestExpiresAt.valueOf() <= source.databaseNow.valueOf() ||
      source.invitationState !== "ENGAGED" ||
      source.quoteState !== "SUBMITTED" ||
      source.providerAccountState !== "ACTIVE" ||
      !source.providerEmailVerified ||
      !source.providerPhoneVerified ||
      !source.authoringEligible ||
      source.deadlinePassed ||
      !source.lifecycleEligible ||
      source.primaryProfessionCode === null
    )
      return { status: "NOT_ACCEPTABLE" };

    await tx`
      SELECT id FROM craftsman_profiles
      WHERE id = ${source.providerProfileId} FOR NO KEY UPDATE
    `;
    await tx`
      LOCK TABLE credential_qualification_policy_activation_events
      IN SHARE MODE
    `;
    await tx`
      SELECT id FROM credential_claims
      WHERE craftsman_profile_id = ${source.providerProfileId}
      ORDER BY id FOR UPDATE
    `;

    const [providerEligible] = await tx<Array<{ eligible: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM current_searchable_craftsman_profiles searchable
        WHERE searchable.craftsman_profile_id = ${source.providerProfileId}
      ) AND NOT EXISTS (
        SELECT 1 FROM current_credential_qualification_policies policy
        WHERE policy.profession_code = ${source.primaryProfessionCode}
          AND policy.requirement = 'REQUIRED'
          AND NOT EXISTS (
            SELECT 1 FROM credential_claims credential
            JOIN current_craftsman_professions profession
              ON profession.id = credential.craftsman_profession_id
              AND profession.craftsman_profile_id = credential.craftsman_profile_id
            WHERE credential.craftsman_profile_id = ${source.providerProfileId}
              AND profession.profession_code = ${source.primaryProfessionCode}
              AND credential.credential_type_code = policy.credential_type_code
              AND credential.state = 'APPROVED'
              AND (credential.expires_on IS NULL
                OR credential.expires_on >= clock_timestamp()::date)
          )
      ) AS eligible
    `;
    if (providerEligible?.eligible !== true)
      return { status: "NOT_ACCEPTABLE" };

    const [stillEligible] = await tx<Array<{ eligible: boolean }>>`
      SELECT context.lifecycle_acceptance_eligible
        AND request.expires_at > clock_timestamp() AS eligible
      FROM current_quote_acceptance_context context
      JOIN quotes quote ON quote.id = context.quote_id
      JOIN job_invitations invitation ON invitation.id = quote.invitation_id
      JOIN current_job_requests request ON request.id = invitation.job_request_id
      WHERE context.quote_id = ${input.quoteId}
        AND context.quote_revision = ${input.quoteRevision}
        AND context.state_revision = ${input.expectedQuoteStateRevision}
    `;
    if (stillEligible?.eligible !== true) return { status: "NOT_ACCEPTABLE" };

    const [created] = await tx<Array<{ acceptedAt: Date; id: string }>>`
      INSERT INTO jobs (
        id, job_request_id, customer_profile_id, primary_craftsman_profile_id,
        winning_invitation_id, winning_conversation_id, accepted_quote_id,
        accepted_quote_revision, accepted_request_content_revision,
        accepted_request_visible_version, acceptance_command_id,
        acceptance_payload_fingerprint, accepted_by_user_id
      ) VALUES (
        ${randomUUID()}, ${input.jobRequestId}, ${source.customerProfileId},
        ${source.providerProfileId}, ${source.invitationId},
        ${source.winningConversationId}, ${input.quoteId},
        ${input.quoteRevision}, ${source.contentRevision},
        ${source.visibleVersion}, ${input.commandId}, ${fingerprint},
        ${input.actorUserId}
      ) RETURNING id, accepted_at AS "acceptedAt"
    `;
    if (created === undefined) throw new Error("Job creation effect missing.");

    await insertQuoteAcceptanceEvent(
      tx,
      created.id,
      input.quoteId,
      input.quoteRevision,
      "ACCEPTED",
    );
    const competingQuotes = await tx<
      Array<{ quoteId: string; quoteRevision: number }>
    >`
      SELECT current.quote_id AS "quoteId",
        current.revision AS "quoteRevision"
      FROM current_submitted_quotes current
      JOIN quotes quote ON quote.id = current.quote_id
      JOIN job_invitations invitation ON invitation.id = quote.invitation_id
      WHERE invitation.job_request_id = ${input.jobRequestId}
        AND current.quote_id <> ${input.quoteId}
      ORDER BY current.quote_id, current.revision
    `;
    for (const competitor of competingQuotes)
      await insertQuoteAcceptanceEvent(
        tx,
        created.id,
        competitor.quoteId,
        competitor.quoteRevision,
        "NOT_SELECTED",
      );

    const competingInvitations = await tx<
      Array<{ id: string; revision: number }>
    >`
      SELECT current.id, current.revision
      FROM current_job_invitations current
      WHERE current.job_request_id = ${input.jobRequestId}
        AND current.id <> ${source.invitationId}
        AND current.state IN ('PENDING', 'ENGAGED')
      ORDER BY current.id
    `;
    for (const invitation of competingInvitations) {
      const commandId = randomUUID();
      const closureFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            acceptanceJobId: created.id,
            invitationId: invitation.id,
            revision: invitation.revision,
          }),
        )
        .digest("hex");
      await tx`
        INSERT INTO job_invitation_commands (
          command_id, invitation_id, actor_user_id, command_kind,
          expected_revision, resulting_revision, target_state,
          system_initiated, decline_reason, decline_note, payload_fingerprint
        ) VALUES (
          ${commandId}, ${invitation.id}, NULL, 'NOT_SELECT',
          ${invitation.revision}, ${invitation.revision + 1}, 'NOT_SELECTED',
          true, NULL, NULL, ${closureFingerprint}
        )
      `;
      await tx`
        INSERT INTO job_invitation_revisions (
          invitation_id, revision, command_id, state, changed_at,
          sent_at, expires_at, engaged_at, decline_reason, decline_note
        ) VALUES (
          ${invitation.id}, ${invitation.revision + 1}, ${commandId},
          'NOT_SELECTED', clock_timestamp(), clock_timestamp(),
          clock_timestamp(), NULL, NULL, NULL
        )
      `;
    }
    if (input.finalExactAddress !== undefined) {
      const [currentLocation] = await tx<
        Array<{
          locationPayload: {
            municipalityCode: string;
            exactAddress: string | null;
            mapPin: { latitude: number; longitude: number } | null;
            textClarification: string | null;
          };
        }>
      >`
        SELECT location_payload AS "locationPayload"
        FROM current_job_locations WHERE job_id = ${created.id}
      `;
      if (currentLocation === undefined)
        throw new Error("Initial Job location missing.");
      const current = currentLocation.locationPayload;
      if (current.exactAddress !== null) {
        if (current.exactAddress !== input.finalExactAddress)
          throw new FinalAddressConflictError();
      } else {
        const clarification = await createJobLocationClarificationRepository(
          tx,
        ).clarify({
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          expectedRevision: 1,
          jobId: created.id,
          location: {
            exactAddress: input.finalExactAddress,
            mapPin: current.mapPin,
            municipalityCode: current.municipalityCode,
            textClarification: current.textClarification,
          },
          reason: "Doplnenie adresy pri záverečnom potvrdení ponuky.",
        });
        if (clarification.status !== "APPLIED")
          throw new Error("Final Job location was not recorded.");
      }
    }
    return Object.freeze({
      acceptedAt: created.acceptedAt,
      jobId: created.id as JobId,
      status: "APPLIED" as const,
    });
  });
}

async function insertQuoteAcceptanceEvent(
  tx: TransactionSql,
  jobId: string,
  quoteId: string,
  quoteRevision: number,
  state: "ACCEPTED" | "NOT_SELECTED",
): Promise<void> {
  await tx`
    INSERT INTO quote_revision_state_events (
      quote_id, quote_revision, state_revision, command_id,
      lifecycle_command_id, acceptance_job_id, state,
      changed_at, submitted_at
    ) VALUES (
      ${quoteId}, ${quoteRevision}, 1, NULL, NULL, ${jobId},
      ${state}, clock_timestamp(), clock_timestamp()
    )
  `;
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
