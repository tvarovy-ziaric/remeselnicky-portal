import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { QuoteAcceptanceIdempotencyError } from "@portal/domain";

import { createQuoteAcceptanceRepository } from "../src/quote-acceptance-repository.js";
import { createJobContactRepository } from "../src/job-contact-repository.js";
import {
  createJobLocationClarificationRepository,
  JobLocationIdempotencyError,
  type JobWorkLocation,
} from "../src/job-location-clarification-repository.js";

interface Source {
  readonly actorUserId: string;
  readonly jobRequestId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly quoteStateRevision: number;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly providerOwnerId: string;
  readonly winningInvitationId: string;
}

export async function runQuoteAcceptanceRepositoryIntegrationAssertions(
  sql: Sql,
): Promise<{
  readonly actorUserId: string;
  readonly jobRequestId: string;
  readonly winningInvitationId: string;
}> {
  const [source] = await sql<Source[]>`
    SELECT customer.owner_user_id AS "actorUserId",
      invitation.job_request_id AS "jobRequestId",
      context.quote_id AS "quoteId",
      context.quote_revision AS "quoteRevision",
      context.state_revision AS "quoteStateRevision",
      context.request_content_revision AS "requestContentRevision",
      context.request_visible_version AS "requestVisibleVersion",
      craftsman.owner_user_id AS "providerOwnerId",
      invitation.id AS "winningInvitationId"
    FROM current_quote_acceptance_context context
    JOIN quotes quote ON quote.id = context.quote_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN current_job_invitations current_invitation
      ON current_invitation.id = invitation.id
    JOIN current_job_requests request ON request.id = invitation.job_request_id
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    JOIN current_searchable_craftsman_profiles searchable
      ON searchable.craftsman_profile_id = invitation.craftsman_profile_id
    WHERE context.lifecycle_acceptance_eligible
      AND current_invitation.state = 'ENGAGED'
      AND request.expires_at > clock_timestamp()
      AND EXISTS (
        SELECT 1 FROM current_submitted_quotes competitor
        JOIN quotes competitor_quote ON competitor_quote.id = competitor.quote_id
        JOIN job_invitations competitor_invitation
          ON competitor_invitation.id = competitor_quote.invitation_id
        WHERE competitor_invitation.job_request_id = invitation.job_request_id
          AND competitor.quote_id <> context.quote_id
      )
    ORDER BY context.quote_id, context.quote_revision DESC
    LIMIT 1
  `;
  if (source === undefined)
    throw new Error("Acceptance-ready Quote fixture is missing.");
  const [competitorsBefore] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM current_job_invitations
    WHERE job_request_id = ${source.jobRequestId}
      AND id <> ${source.winningInvitationId}
      AND state IN ('PENDING', 'ENGAGED')
  `;
  expect(competitorsBefore?.count).toBeGreaterThan(0);
  const [before] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM jobs
  `;
  const input = {
    actorUserId: source.actorUserId as never,
    commandId: randomUUID(),
    explicitlyConfirmed: true as const,
    expectedQuoteStateRevision: source.quoteStateRevision,
    expectedRequestContentRevision: source.requestContentRevision,
    expectedRequestVisibleVersion: source.requestVisibleVersion,
    jobRequestId: source.jobRequestId as never,
    quoteId: source.quoteId as never,
    quoteRevision: source.quoteRevision,
  };
  await assertRequestLockSerializesConcurrentAcceptance(sql, input);
  const marker = new Error("rollback acceptQuote transaction assertions");
  await expect(
    sql.begin(async (tx) => {
      const repository = createQuoteAcceptanceRepository(tx);
      expect(
        await repository.accept({
          ...input,
          actorUserId: randomUUID() as never,
        }),
      ).toEqual({ status: "NOT_FOUND" });
      expect(
        await repository.accept({
          ...input,
          expectedQuoteStateRevision: input.expectedQuoteStateRevision + 1,
        }),
      ).toEqual({ status: "STALE_REVISION" });
      const customerGateRollback = new Error("rollback customer ineligibility");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE users SET account_state = 'SUSPENDED',
              account_state_changed_at = clock_timestamp(),
              updated_at = clock_timestamp()
            WHERE id = ${source.actorUserId}
          `;
          expect(
            await createQuoteAcceptanceRepository(savepoint).accept({
              ...input,
              commandId: randomUUID(),
            }),
          ).toEqual({ status: "NOT_FOUND" });
          throw customerGateRollback;
        }),
      ).rejects.toBe(customerGateRollback);
      const providerGateRollback = new Error("rollback provider suspension");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE users SET account_state = 'SUSPENDED',
              account_state_changed_at = clock_timestamp(),
              updated_at = clock_timestamp()
            WHERE id = ${source.providerOwnerId}
          `;
          expect(
            await createQuoteAcceptanceRepository(savepoint).accept({
              ...input,
              commandId: randomUUID(),
            }),
          ).toEqual({ status: "NOT_ACCEPTABLE" });
          throw providerGateRollback;
        }),
      ).rejects.toBe(providerGateRollback);
      await tx`
        CREATE FUNCTION r4_acceptance_rollback_test_guard()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state = 'NOT_SELECTED' THEN
            RAISE EXCEPTION 'forced competitor closeout failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await tx`
        CREATE TRIGGER r4_acceptance_rollback_test_guard
        BEFORE INSERT ON job_invitation_revisions
        FOR EACH ROW EXECUTE FUNCTION r4_acceptance_rollback_test_guard()
      `;
      await expect(
        repository.accept({ ...input, commandId: randomUUID() }),
      ).rejects.toThrow("forced competitor closeout failure");
      const [rolledBack] = await tx<
        Array<{ jobCount: number; quoteState: string }>
      >`
        SELECT (SELECT count(*)::integer FROM jobs
          WHERE job_request_id = ${source.jobRequestId}) AS "jobCount",
          (SELECT state::text FROM current_quote_revision_states
            WHERE quote_id = ${source.quoteId}
              AND revision = ${source.quoteRevision}) AS "quoteState"
      `;
      expect(rolledBack).toEqual({ jobCount: 0, quoteState: "SUBMITTED" });
      await tx`
        DROP TRIGGER r4_acceptance_rollback_test_guard
        ON job_invitation_revisions
      `;
      await tx`DROP FUNCTION r4_acceptance_rollback_test_guard()`;
      const finalAddressRollback = new Error(
        "rollback final-address acceptance assertion",
      );
      await expect(
        tx.savepoint(async (savepoint) => {
          const withAddress = await createQuoteAcceptanceRepository(
            savepoint,
          ).accept({
            ...input,
            commandId: randomUUID(),
            finalExactAddress: "Syntetická 47",
          });
          expect(withAddress.status).toBe("APPLIED");
          if (withAddress.status !== "APPLIED")
            throw new Error("Final-address Job was not created.");
          const [location] = await savepoint<
            Array<{
              acceptedAddress: string | null;
              currentAddress: string | null;
              revision: number;
            }>
          >`
            SELECT snapshot.request_snapshot #>>
                '{sections,request.location,payload,exactAddress}'
                AS "acceptedAddress",
              current.location_payload ->> 'exactAddress'
                AS "currentAddress",
              current.revision
            FROM job_agreement_snapshots snapshot
            JOIN current_job_locations current ON current.job_id = snapshot.job_id
            WHERE snapshot.job_id = ${withAddress.jobId}
          `;
          expect(location).toEqual({
            acceptedAddress: null,
            currentAddress: "Syntetická 47",
            revision: 2,
          });
          expect(
            await createQuoteAcceptanceRepository(savepoint).accept({
              ...input,
              commandId: input.commandId,
              finalExactAddress: "Syntetická 47",
            }),
          ).toEqual({ status: "NOT_ACCEPTABLE" });
          throw finalAddressRollback;
        }),
      ).rejects.toBe(finalAddressRollback);
      const applied = await repository.accept(input);
      expect(applied.status).toBe("APPLIED");
      if (applied.status !== "APPLIED") throw new Error("Job was not created.");
      const contacts = createJobContactRepository(tx);
      const customerContact = await contacts.readForPrimaryParty({
        actorUserId: source.actorUserId,
        jobId: applied.jobId,
      });
      expect(customerContact?.customer.email).toMatch(/@/u);
      expect(customerContact?.customer.phone).toMatch(/^\+[1-9]/u);
      expect(customerContact?.provider.email).toMatch(/@/u);
      expect(customerContact?.provider.phone).toMatch(/^\+[1-9]/u);
      expect(
        customerContact?.workLocation.municipalityCode.length,
      ).toBeGreaterThan(0);
      expect(
        await contacts.readForPrimaryParty({
          actorUserId: source.providerOwnerId,
          jobId: applied.jobId,
        }),
      ).toEqual(customerContact);
      const [acceptedAddress] = await tx<
        Array<{ exactAddress: string | null }>
      >`
        SELECT request_snapshot #>>
          '{sections,request.location,payload,exactAddress}'
          AS "exactAddress"
        FROM job_agreement_snapshots WHERE job_id = ${applied.jobId}
      `;
      expect(customerContact?.workLocation.exactAddress).toBe(
        acceptedAddress?.exactAddress,
      );
      const [initialLocation] = await tx<
        Array<{ revision: number; origin: string; exactAddress: string | null }>
      >`
        SELECT revision, origin,
          location_payload ->> 'exactAddress' AS "exactAddress"
        FROM current_job_locations WHERE job_id = ${applied.jobId}
      `;
      expect(initialLocation).toEqual({
        exactAddress: acceptedAddress?.exactAddress,
        origin: "ACCEPTED_REQUEST",
        revision: 1,
      });
      if (customerContact === null)
        throw new Error("Confirmed Job contact fixture is missing.");
      const initialWorkLocation = customerContact.workLocation;
      const clarifiedLocation: JobWorkLocation =
        initialWorkLocation.exactAddress === null
          ? { ...initialWorkLocation, exactAddress: "Syntetická 12" }
          : initialWorkLocation.textClarification === null
            ? {
                ...initialWorkLocation,
                textClarification: "Vstup cez bočnú bránu",
              }
            : initialWorkLocation.mapPin === null
              ? {
                  ...initialWorkLocation,
                  mapPin: { latitude: 48.15, longitude: 17.12 },
                }
              : (() => {
                  throw new Error("No missing fixture location detail.");
                })();
      const clarificationRollback = new Error(
        "rollback Job location clarification assertions",
      );
      await expect(
        tx.savepoint(async (savepoint) => {
          const clarification =
            createJobLocationClarificationRepository(savepoint);
          const command = {
            actorUserId: source.actorUserId,
            commandId: randomUUID(),
            expectedRevision: 1,
            jobId: applied.jobId,
            location: clarifiedLocation,
            reason: "Doplnenie miesta realizácie po potvrdení",
          };
          expect(
            await clarification.clarify({
              ...command,
              actorUserId: source.providerOwnerId,
            }),
          ).toEqual({ status: "NOT_FOUND" });
          expect(
            await clarification.clarify({
              ...command,
              actorUserId: randomUUID(),
            }),
          ).toEqual({ status: "NOT_FOUND" });
          const result = await clarification.clarify(command);
          expect(result.status).toBe("APPLIED");
          if (result.status !== "APPLIED")
            throw new Error("Job clarification was not applied.");
          expect(result.revision).toBe(2);
          expect(result.recordedAt).toBeInstanceOf(Date);
          expect(await clarification.clarify(command)).toEqual({
            ...result,
            status: "DEDUPLICATED",
          });
          await expect(
            clarification.clarify({
              ...command,
              reason: "Iný dôvod pre rovnaký command ID",
            }),
          ).rejects.toBeInstanceOf(JobLocationIdempotencyError);
          expect(
            await clarification.clarify({
              ...command,
              commandId: randomUUID(),
            }),
          ).toEqual({ status: "STALE_REVISION" });
          expect(
            await clarification.clarify({
              ...command,
              commandId: randomUUID(),
              expectedRevision: 2,
              location: {
                ...clarifiedLocation,
                municipalityCode: "TEST:FOREIGN_MUNICIPALITY",
              },
            }),
          ).toEqual({ status: "NOT_CLARIFICATION" });
          const currentAddress = clarifiedLocation.exactAddress;
          if (currentAddress !== null) {
            expect(
              await clarification.clarify({
                ...command,
                commandId: randomUUID(),
                expectedRevision: 2,
                location: {
                  ...clarifiedLocation,
                  exactAddress: "Syntetická 99",
                },
              }),
            ).toEqual({ status: "NOT_CLARIFICATION" });
          }
          expect(
            (
              await createJobContactRepository(savepoint).readForPrimaryParty({
                actorUserId: source.providerOwnerId,
                jobId: applied.jobId,
              })
            )?.workLocation,
          ).toEqual(clarifiedLocation);
          const history = await savepoint<
            Array<{
              origin: string;
              revision: number;
              actorUserId: string | null;
            }>
          >`
            SELECT location.origin, location.revision,
              command.actor_user_id AS "actorUserId"
            FROM job_location_revisions location
            LEFT JOIN job_location_clarification_commands command
              ON command.command_id = location.source_clarification_command_id
            WHERE location.job_id = ${applied.jobId}
            ORDER BY location.revision
          `;
          expect(history).toEqual([
            { actorUserId: null, origin: "ACCEPTED_REQUEST", revision: 1 },
            {
              actorUserId: source.actorUserId,
              origin: "CUSTOMER_CLARIFICATION",
              revision: 2,
            },
          ]);
          await expect(
            savepoint.savepoint(async (nested) => {
              await nested`
                UPDATE job_location_clarification_commands
                SET reason = 'tampered'
                WHERE command_id = ${command.commandId}
              `;
            }),
          ).rejects.toThrow(/immutable/u);
          await expect(
            savepoint.savepoint(async (nested) => {
              await nested`
                INSERT INTO job_location_clarification_commands (
                  command_id, job_id, actor_user_id, expected_revision,
                  location_payload, reason, payload_fingerprint
                ) VALUES (
                  ${randomUUID()}, ${applied.jobId},
                  ${source.providerOwnerId}, 2,
                  ${nested.json(clarifiedLocation as never)},
                  'Neoprávnená úprava miesta práce', ${"0".repeat(64)}
                )
              `;
            }),
          ).rejects.toThrow(/not authorized/u);
          await expect(
            savepoint.savepoint(async (nested) => {
              await nested`
                INSERT INTO job_location_clarification_commands (
                  command_id, job_id, actor_user_id, expected_revision,
                  location_payload, reason, payload_fingerprint
                ) VALUES (
                  ${randomUUID()}, ${applied.jobId},
                  ${source.actorUserId}, 2,
                  ${nested.json({
                    ...clarifiedLocation,
                    municipalityCode: "TEST:FOREIGN_MUNICIPALITY",
                  })},
                  'Pokus o zmenu obce bez dohody', ${"0".repeat(64)}
                )
              `;
            }),
          ).rejects.toThrow(/invalid Job location clarification/u);
          await expect(
            savepoint.savepoint(async (nested) => {
              await nested`
                INSERT INTO job_location_revisions (
                  job_id, revision, location_payload, origin,
                  source_request_content_revision, recorded_at,
                  source_clarification_command_id
                ) SELECT job_id, 3, location_payload, origin,
                  source_request_content_revision, recorded_at,
                  source_clarification_command_id
                FROM job_location_revisions
                WHERE job_id = ${applied.jobId} AND revision = 2
              `;
            }),
          ).rejects.toThrow(/authorized source/u);
          throw clarificationRollback;
        }),
      ).rejects.toBe(clarificationRollback);
      const timeline = await tx<
        Array<{ eventOrder: number; eventType: string }>
      >`
        SELECT event_order AS "eventOrder", event_type AS "eventType"
        FROM job_system_timeline_events
        WHERE job_id = ${applied.jobId}
        ORDER BY event_order
      `;
      expect(timeline).toEqual([
        { eventOrder: 1, eventType: "JOB_CONFIRMED" },
        { eventOrder: 2, eventType: "CONTACT_ADDRESS_UNLOCKED" },
      ]);
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_location_revisions (
              job_id, revision, location_payload, origin,
              source_request_content_revision, recorded_at
            )
            SELECT job_id, 2, location_payload, origin,
              source_request_content_revision, recorded_at
            FROM job_location_revisions
            WHERE job_id = ${applied.jobId} AND revision = 1
          `;
        }),
      ).rejects.toThrow(/authorized source/u);
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE job_system_timeline_events SET event_type = 'JOB_CONFIRMED'
            WHERE job_id = ${applied.jobId} AND event_order = 2
          `;
        }),
      ).rejects.toThrow(/immutable/u);
      const [competitor] = await tx<Array<{ ownerUserId: string }>>`
        SELECT craftsman.owner_user_id AS "ownerUserId"
        FROM job_invitations invitation
        JOIN craftsman_profiles craftsman
          ON craftsman.id = invitation.craftsman_profile_id
        WHERE invitation.job_request_id = ${source.jobRequestId}
          AND invitation.id <> ${source.winningInvitationId}
        LIMIT 1
      `;
      if (competitor === undefined)
        throw new Error("Competitor fixture is missing.");
      expect(
        await contacts.readForPrimaryParty({
          actorUserId: competitor.ownerUserId,
          jobId: applied.jobId,
        }),
      ).toBeNull();
      const suspendedViewerRollback = new Error(
        "rollback suspended contact viewer",
      );
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE users SET account_state = 'SUSPENDED',
              account_state_changed_at = clock_timestamp(),
              updated_at = clock_timestamp()
            WHERE id = ${source.providerOwnerId}
          `;
          expect(
            await createJobContactRepository(savepoint).readForPrimaryParty({
              actorUserId: source.providerOwnerId,
              jobId: applied.jobId,
            }),
          ).toBeNull();
          throw suspendedViewerRollback;
        }),
      ).rejects.toBe(suspendedViewerRollback);
      expect(
        await contacts.readForPrimaryParty({
          actorUserId: source.actorUserId,
          jobId: randomUUID(),
        }),
      ).toBeNull();
      expect(await repository.accept(input)).toEqual({
        ...applied,
        status: "DEDUPLICATED",
      });
      await expect(
        repository.accept({
          ...input,
          expectedQuoteStateRevision: input.expectedQuoteStateRevision + 1,
        }),
      ).rejects.toBeInstanceOf(QuoteAcceptanceIdempotencyError);
      expect(
        await repository.accept({ ...input, commandId: randomUUID() }),
      ).toEqual({ status: "NOT_ACCEPTABLE" });

      const [effects] = await tx<
        Array<{
          activeCompetingInvitations: number;
          acceptanceEventCount: number;
          acceptedQuoteState: string;
          competingSubmittedQuotes: number;
          convertedRequestState: string;
          qualificationSnapshotCount: number;
          locationCount: number;
          snapshotCount: number;
          timelineCount: number;
        }>
      >`
        SELECT
          (SELECT count(*)::integer FROM job_acceptance_events
            WHERE job_id = ${applied.jobId}) AS "acceptanceEventCount",
          (SELECT count(*)::integer FROM job_agreement_snapshots
            WHERE job_id = ${applied.jobId}) AS "snapshotCount",
          (SELECT count(*)::integer FROM job_qualification_snapshots
            WHERE job_id = ${applied.jobId}) AS "qualificationSnapshotCount",
          (SELECT count(*)::integer FROM job_location_revisions
            WHERE job_id = ${applied.jobId}) AS "locationCount",
          (SELECT count(*)::integer FROM job_system_timeline_events
            WHERE job_id = ${applied.jobId}) AS "timelineCount",
          (SELECT state::text FROM current_job_requests
            WHERE id = ${source.jobRequestId}) AS "convertedRequestState",
          (SELECT state::text FROM current_quote_revision_states
            WHERE quote_id = ${source.quoteId}
              AND revision = ${source.quoteRevision}) AS "acceptedQuoteState",
          (SELECT count(*)::integer FROM current_submitted_quotes current
            JOIN quotes quote ON quote.id = current.quote_id
            JOIN job_invitations invitation ON invitation.id = quote.invitation_id
            WHERE invitation.job_request_id = ${source.jobRequestId}
              AND current.quote_id <> ${source.quoteId})
            AS "competingSubmittedQuotes",
          (SELECT count(*)::integer FROM current_job_invitations invitation
            WHERE invitation.job_request_id = ${source.jobRequestId}
              AND invitation.state IN ('PENDING', 'ENGAGED')
              AND invitation.id NOT IN (
                SELECT winning_invitation_id FROM jobs WHERE id = ${applied.jobId}
              )) AS "activeCompetingInvitations"
      `;
      expect(effects).toEqual({
        activeCompetingInvitations: 0,
        acceptanceEventCount: 1,
        acceptedQuoteState: "ACCEPTED",
        competingSubmittedQuotes: 0,
        convertedRequestState: "CONVERTED",
        qualificationSnapshotCount: 1,
        locationCount: 1,
        snapshotCount: 1,
        timelineCount: 2,
      });
      const notifications = await tx<
        Array<{ eventName: string; payload: Record<string, unknown> }>
      >`
        SELECT event_name AS "eventName", payload
        FROM domain_outbox_events
        WHERE event_name = 'job_invitation.not_selected'
          AND entity_id IN (
            SELECT id::text FROM job_invitations
            WHERE job_request_id = ${source.jobRequestId}
          )
      `;
      for (const notification of notifications) {
        expect(notification.eventName).toBe("job_invitation.not_selected");
        expect(Object.keys(notification.payload).sort()).toEqual([
          "invitation_revision",
          "recipient_user_id",
        ]);
      }
      expect(notifications.length).toBeGreaterThan(0);
      throw marker;
    }),
  ).rejects.toBe(marker);
  const [after] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM jobs
  `;
  expect(after?.count).toBe(before?.count);
  return {
    actorUserId: source.actorUserId,
    jobRequestId: source.jobRequestId,
    winningInvitationId: source.winningInvitationId,
  };
}

async function assertRequestLockSerializesConcurrentAcceptance(
  sql: Sql,
  input: Parameters<
    ReturnType<typeof createQuoteAcceptanceRepository>["accept"]
  >[0],
): Promise<void> {
  let signalReady: () => void = () => undefined;
  let releaseFirst: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const marker = new Error("rollback first concurrent acceptance");
  const first = sql.begin(async (tx) => {
    try {
      const result = await createQuoteAcceptanceRepository(tx).accept({
        ...input,
        commandId: randomUUID(),
      });
      expect(result.status).toBe("APPLIED");
      signalReady();
      await release;
      throw marker;
    } catch (error) {
      signalReady();
      throw error;
    }
  });
  const firstOutcome = first.then(
    () => new Error("first acceptance unexpectedly committed"),
    (error: unknown) => error,
  );
  await ready;
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '300ms'`;
      await expect(
        createQuoteAcceptanceRepository(tx).accept({
          ...input,
          commandId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    });
  } finally {
    releaseFirst();
  }
  expect(await firstOutcome).toBe(marker);
  const [after] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM jobs
    WHERE job_request_id = ${input.jobRequestId}
  `;
  expect(after?.count).toBe(0);
}
