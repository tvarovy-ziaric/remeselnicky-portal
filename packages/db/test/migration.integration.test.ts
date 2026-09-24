import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { createIdempotentConsumer, defineDomainEvent } from "@portal/outbox";
import { createAdminAccessService } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";

import { migratePostgres } from "../src/migrator.js";
import { createMunicipalityAutocompleteRepository } from "../src/municipality-autocomplete-repository.js";
import {
  createAdminAccessRepository,
  createAuthRepository,
  createEmailVerificationRepository,
  createMediaRepository,
  createPrivateMediaDeliveryRepository,
  createOutboxRepository,
  createPhoneVerificationRepository,
  createTaxonomyAutocompleteRepository,
  type CreateProcessingMediaAssetInput,
} from "../src/index.js";
import { runNotificationIntegrationAssertions } from "./notification-integration-helper.js";
import { runAuditIntegrationAssertions } from "./audit-integration-helper.js";
import { runPrivacyIntegrationAssertions } from "./privacy-integration-helper.js";
import { runTaxonomyIntegrationAssertions } from "./taxonomy-integration-helper.js";
import { runCustomerProfileIntegrationAssertions } from "./customer-profile-integration-helper.js";
import { runCraftsmanProfileIntegrationAssertions } from "./craftsman-profile-integration-helper.js";
import { runCraftsmanProfessionIntegrationAssertions } from "./craftsman-profession-integration-helper.js";
import { runCraftsmanCapabilityIntegrationAssertions } from "./craftsman-capability-integration-helper.js";
import { runCraftsmanServiceAreaIntegrationAssertions } from "./craftsman-service-area-integration-helper.js";
import { runIndicativePricingIntegrationAssertions } from "./indicative-pricing-integration-helper.js";
import { runCraftsmanExperienceIntegrationAssertions } from "./craftsman-experience-integration-helper.js";
import { runCraftsmanAvailabilityIntegrationAssertions } from "./craftsman-availability-integration-helper.js";
import { runPortfolioProjectIntegrationAssertions } from "./portfolio-project-integration-helper.js";
import { runCredentialClaimIntegrationAssertions } from "./credential-claim-integration-helper.js";
import { runCraftsmanPublicationIntegrationAssertions } from "./craftsman-publication-integration-helper.js";
import { runPortfolioProjectMediaIntegrationAssertions } from "./portfolio-project-media-integration-helper.js";
import { runPortfolioCollaborationIntegrationAssertions } from "./portfolio-collaboration-integration-helper.js";
import { runFeaturedProjectIntegrationAssertions } from "./featured-project-integration-helper.js";
import { runPortfolioPublicationIntegrationAssertions } from "./portfolio-publication-integration-helper.js";
import { runR1SupplySideIntegrationAssertions } from "./r1-supply-side-integration-helper.js";
import { runPublicSearchCardIntegrationAssertions } from "./public-search-card-integration-helper.js";
import { runCraftsmanDistanceIntegrationAssertions } from "./craftsman-distance-integration-helper.js";
import { runCraftsmanServiceAreaMatchIntegrationAssertions } from "./craftsman-service-area-match-integration-helper.js";
import { runCraftsmanAvailabilityMatchIntegrationAssertions } from "./craftsman-availability-match-integration-helper.js";
import { runCraftsmanTrustEvidenceIntegrationAssertions } from "./craftsman-trust-evidence-integration-helper.js";
import { runCustomerShortlistIntegrationAssertions } from "./customer-shortlist-integration-helper.js";
import { runJobRequestIntegrationAssertions } from "./job-request-integration-helper.js";
import { runJobRequestDraftIntegrationAssertions } from "./job-request-draft-integration-helper.js";
import { runJobRequestContentIntegrationAssertions } from "./job-request-content-integration-helper.js";
import { runJobRequestVersionIntegrationAssertions } from "./job-request-version-integration-helper.js";
import { runJobRequestLifecycleIntegrationAssertions } from "./job-request-lifecycle-integration-helper.js";
import { runJobInvitationIntegrationAssertions } from "./job-invitation-integration-helper.js";
import { runJobInvitationNotificationIntegrationAssertions } from "./job-invitation-notification-integration-helper.js";
import {
  runConversationIntegrationAssertions,
  runConversationReadOnlyIntegrationAssertions,
} from "./conversation-integration-helper.js";
import {
  runConversationChatIntegrationAssertions,
  runConversationChatReadOnlyIntegrationAssertions,
} from "./conversation-chat-integration-helper.js";
import { runConversationAttachmentIntegrationAssertions } from "./conversation-attachment-integration-helper.js";
import { runConversationMessagePolicyIntegrationAssertions } from "./conversation-message-policy-integration-helper.js";
import { runQuoteIntegrationAssertions } from "./quote-integration-helper.js";
import { runStructuredQuoteIntegrationAssertions } from "./quote-structured-integration-helper.js";
import { runExternalPdfQuoteIntegrationAssertions } from "./quote-external-pdf-integration-helper.js";
import { runQuoteComparisonIntegrationAssertions } from "./quote-comparison-integration-helper.js";
import { runQuoteLifecycleIntegrationAssertions } from "./quote-lifecycle-integration-helper.js";
import { runDemandSideNotificationIntegrationAssertions } from "./demand-side-notification-integration-helper.js";
import {
  runR3AnalyticsIntegrationAssertions,
  runR3AnalyticsPostLifecycleAssertions,
} from "./r3-analytics-integration-helper.js";
import { runR3DemandSideSecurityIntegrationAssertions } from "./r3-demand-side-security-integration-helper.js";
import { runMediaProcessingQueueIntegrationAssertions } from "./media-processing-queue-integration-helper.js";
import { runJobAcceptanceIdentityIntegrationAssertions } from "./job-acceptance-identity-integration-helper.js";
import { runQuoteAcceptanceRepositoryIntegrationAssertions } from "./quote-acceptance-repository-integration-helper.js";
import { runQuoteAcceptanceCommittedRaceIntegrationAssertions } from "./quote-acceptance-committed-race-integration-helper.js";
import { runJobLifecycleIntegrationAssertions } from "./job-lifecycle-integration-helper.js";
import { runJobDocumentationIntegrationAssertions } from "./job-documentation-integration-helper.js";
import {
  runJobRosterCancelledIntegrationAssertions,
  runJobRosterIdentityIntegrationAssertions,
} from "./job-roster-identity-integration-helper.js";
import {
  runJobRosterCancelledReadIntegrationAssertions,
  runJobRosterReadIntegrationAssertions,
} from "./job-roster-read-integration-helper.js";
import { runJobParticipationCommandsIntegrationAssertions } from "./job-participation-commands-integration-helper.js";
import { runJobParticipantCapabilityIntegrationAssertions } from "./job-participant-capability-integration-helper.js";
import { runJobOperationalIntegrationAssertions } from "./job-operational-integration-helper.js";
import { runJobOperationalMediaIntegrationAssertions } from "./job-operational-media-integration-helper.js";
import { runJobMilestoneIntegrationAssertions } from "./job-milestone-integration-helper.js";
import { runJobMilestoneContextIntegrationAssertions } from "./job-milestone-context-integration-helper.js";
import { runChangeOrderIntegrationAssertions } from "./change-order-integration-helper.js";
import { runChangeOrderPdfIntegrationAssertions } from "./change-order-pdf-integration-helper.js";
import { runJobCompletionIntegrationAssertions } from "./job-completion-integration-helper.js";
import { runMainBilateralReviewIntegrationAssertions } from "./main-bilateral-review-integration-helper.js";
import { runVerifiedCompletionEvidenceIntegrationAssertions } from "./verified-completion-evidence-integration-helper.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const integrationEventDefinition = defineDomainEvent({
  eventName: "integration.completed",
  payloadKeys: ["entity_id", "outcome"] as const,
  schemaVersion: 1,
});

describe.skipIf(testDatabaseUrl === undefined)(
  "clean PostgreSQL/PostGIS migrations",
  () => {
    it("applies the complete migration set and is idempotent", async () => {
      if (testDatabaseUrl === undefined) {
        throw new Error("TEST_DATABASE_URL is required for integration tests");
      }

      const firstRun = await migratePostgres(
        testDatabaseUrl,
        migrationsDirectory,
      );
      expect(firstRun).toEqual({
        applied: [
          "0000_enable_postgis.sql",
          "0001_create_users.sql",
          "0002_authentication.sql",
          "0003_media_assets.sql",
          "0004_email_verification.sql",
          "0005_image_canonicalization.sql",
          "0006_phone_verification.sql",
          "0007_transactional_outbox.sql",
          "0008_document_validation.sql",
          "0009_admin_privileged_access.sql",
          "0010_notifications.sql",
          "0011_immutable_audit_log.sql",
          "0012_privacy_compliance_scaffolding.sql",
          "0013_profession_taxonomy.sql",
          "0014_customer_profile.sql",
          "0015_craftsman_profile.sql",
          "0016_craftsman_professions.sql",
          "0017_skills_specializations.sql",
          "0018_craftsman_service_area.sql",
          "0019_indicative_pricing.sql",
          "0020_craftsman_experience.sql",
          "0021_craftsman_availability.sql",
          "0022_portfolio_project_core.sql",
          "0023_credential_claim_review.sql",
          "0024_craftsman_profile_publication.sql",
          "0025_portfolio_project_photos.sql",
          "0026_portfolio_collaborations.sql",
          "0027_featured_projects.sql",
          "0028_portfolio_publication_consent_hooks.sql",
          "0029_craftsman_search_read_model.sql",
          "0030_craftsman_distance_facts.sql",
          "0031_craftsman_service_area_matching.sql",
          "0032_credential_qualification_gate.sql",
          "0033_craftsman_availability_matching.sql",
          "0034_trust_evidence_read_model.sql",
          "0035_customer_shortlist.sql",
          "0036_job_request_core.sql",
          "0037_job_request_draft_autosave.sql",
          "0038_job_request_content_validation.sql",
          "0039_job_request_active_versions.sql",
          "0040_job_request_operational_lifecycle.sql",
          "0041_job_invitations.sql",
          "0042_job_invitation_auth_verification.sql",
          "0043_job_invitation_notifications.sql",
          "0044_conversation_entity.sql",
          "0045_conversation_chat.sql",
          "0046_conversation_attachments.sql",
          "0047_conversation_preconfirm_policy.sql",
          "0048_quote_core.sql",
          "0049_quote_platform_structured.sql",
          "0050_quote_external_pdf.sql",
          "0051_quote_lifecycle.sql",
          "0052_demand_side_notifications.sql",
          "0053_r3_analytics_funnel.sql",
          "0054_media_processing_queue.sql",
          "0055_job_acceptance_identity.sql",
          "0056_quote_request_serialization.sql",
          "0057_job_agreement_snapshot.sql",
          "0058_job_request_converted_state.sql",
          "0059_job_request_conversion_projection.sql",
          "0060_quote_acceptance_state_events.sql",
          "0061_job_qualification_snapshot.sql",
          "0062_job_acceptance_event.sql",
          "0063_job_conversation_media.sql",
          "0064_quote_supporting_documents.sql",
          "0065_job_contact_unlock_location.sql",
          "0066_job_location_clarification.sql",
          "0067_job_execution_state_labels.sql",
          "0068_job_lifecycle_commands.sql",
          "0069_job_roster_identities.sql",
          "0070_job_participation_events.sql",
          "0071_job_work_group_composition.sql",
          "0072_job_participant_roles.sql",
          "0073_crew_membership_history.sql",
          "0074_job_participant_invitation_idempotency.sql",
          "0075_job_participation_timeline.sql",
          "0076_job_participant_capability_evidence.sql",
          "0077_job_participation_notifications.sql",
          "0078_job_operational_updates.sql",
          "0079_job_operational_media.sql",
          "0080_job_milestones.sql",
          "0081_job_milestone_context.sql",
          "0082_change_order_foundation.sql",
          "0083_change_order_pdf_reservations.sql",
          "0084_job_milestone_change_order_provenance.sql",
          "0085_job_completion_states.sql",
          "0086_job_completion_attempts.sql",
          "0087_customer_completion_proposals.sql",
          "0088_admin_job_force_completion.sql",
          "0089_verified_completed_job_evidence.sql",
          "0090_completed_job_work_volume.sql",
          "0091_job_participant_role_decisions.sql",
          "0092_main_bilateral_review_foundation.sql",
        ],
        alreadyApplied: 0,
      });

      const secondRun = await migratePostgres(
        testDatabaseUrl,
        migrationsDirectory,
      );
      expect(secondRun).toEqual({ applied: [], alreadyApplied: 93 });

      const sql = postgres(testDatabaseUrl, { max: 5 });
      try {
        const [postgis] = await sql<{ extversion: string }[]>`
          SELECT extversion
          FROM pg_extension
          WHERE extname = 'postgis'
        `;
        const [ledger] = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM portal_schema_migrations
        `;

        const [created] = await sql<
          {
            id: string;
            account_state: string;
            account_state_changed_at: Date;
            created_at: Date;
            updated_at: Date;
          }[]
        >`
          INSERT INTO users DEFAULT VALUES
          RETURNING
            id,
            account_state,
            account_state_changed_at,
            created_at,
            updated_at
        `;

        const [persisted] = await sql<{ id: string; account_state: string }[]>`
          SELECT id, account_state
          FROM users
          WHERE id = ${created!.id}
        `;

        const columns = await sql<{ column_name: string }[]>`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
          ORDER BY ordinal_position
        `;

        expect(postgis?.extversion).toMatch(/^3\./);
        expect(ledger?.count).toBe(93);
        expect(created).toMatchObject({ account_state: "ACTIVE" });
        expect(created?.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(created?.account_state_changed_at).toEqual(created?.created_at);
        expect(created?.updated_at).toEqual(created?.created_at);
        expect(persisted).toEqual({
          id: created?.id,
          account_state: "ACTIVE",
        });

        const retainedStates = await sql<{ account_state: string }[]>`
          INSERT INTO users (account_state)
          VALUES ('SUSPENDED'), ('DEACTIVATED')
          RETURNING account_state
        `;
        expect(
          retainedStates.map(({ account_state }) => account_state),
        ).toEqual(["SUSPENDED", "DEACTIVATED"]);

        expect(columns.map(({ column_name }) => column_name)).toEqual([
          "id",
          "account_state",
          "account_state_changed_at",
          "created_at",
          "updated_at",
        ]);

        await expect(
          sql`INSERT INTO users (account_state) VALUES (${"ADMIN"})`,
        ).rejects.toThrow();

        const createdAt = new Date("2026-09-14T00:00:00.000Z");
        const beforeCreation = new Date("2026-09-13T23:59:59.000Z");
        await expect(
          sql`
            INSERT INTO users (
              created_at,
              account_state_changed_at,
              updated_at
            ) VALUES (${createdAt}, ${beforeCreation}, ${createdAt})
          `,
        ).rejects.toThrow(/users_state_change_not_before_creation/);

        const beforeStateChange = new Date("2026-09-14T00:00:01.000Z");
        const stateChangedAt = new Date("2026-09-14T00:00:02.000Z");
        await expect(
          sql`
            INSERT INTO users (
              created_at,
              account_state_changed_at,
              updated_at
            ) VALUES (${createdAt}, ${stateChangedAt}, ${beforeStateChange})
          `,
        ).rejects.toThrow(/users_update_not_before_state_change/);

        const auth = createAuthRepository(sql);
        const unique = randomUUID();
        const normalizedEmail = `auth-${unique}@example.test`;
        const initialPasswordHash = `$argon2id$${"a".repeat(64)}`;
        const replacementPasswordHash = `$argon2id$${"b".repeat(64)}`;
        const beforeRegistration = new Date();
        const registration = await auth.registerUserWithCredential({
          adultAttested: true,
          normalizedEmail,
          passwordHash: initialPasswordHash,
        });
        expect(registration.status).toBe("CREATED");
        if (registration.status !== "CREATED") {
          throw new Error("Expected a newly registered authentication user.");
        }
        expect(
          registration.user.adultAttestedAt.valueOf(),
        ).toBeGreaterThanOrEqual(beforeRegistration.valueOf());
        expect(registration.user.adultAttestedAt.valueOf()).toBeLessThanOrEqual(
          Date.now(),
        );

        await expect(
          auth.registerUserWithCredential({
            adultAttested: true,
            normalizedEmail,
            passwordHash: initialPasswordHash,
          }),
        ).resolves.toEqual({ status: "DUPLICATE" });

        const credential =
          await auth.findCredentialByNormalizedEmail(normalizedEmail);
        expect(credential?.emailVerifiedAt).toBeNull();

        const verification = createEmailVerificationRepository(sql);
        const verificationDigests = [
          digest(`email-verification-a-${unique}`),
          digest(`email-verification-b-${unique}`),
        ];
        const verificationExpiry = new Date(Date.now() + 60_000);
        const issued = await Promise.all(
          verificationDigests.map((tokenDigest) =>
            verification.issue({
              expiresAt: verificationExpiry,
              tokenDigest,
              userId: registration.user.id,
            }),
          ),
        );
        expect(issued).toEqual([
          { normalizedEmail, status: "ISSUED" },
          { normalizedEmail, status: "ISSUED" },
        ]);
        const verificationRows = await sql<
          {
            invalidatedAt: Date | null;
            tokenDigest: string;
          }[]
        >`
          SELECT
            invalidated_at AS "invalidatedAt",
            token_digest AS "tokenDigest"
          FROM email_verification_tokens
          WHERE user_id = ${registration.user.id}
        `;
        expect(verificationRows).toHaveLength(2);
        expect(
          verificationRows.filter(
            ({ invalidatedAt }) => invalidatedAt === null,
          ),
        ).toHaveLength(1);
        const liveVerificationDigest = verificationRows.find(
          ({ invalidatedAt }) => invalidatedAt === null,
        )?.tokenDigest;
        if (liveVerificationDigest === undefined) {
          throw new Error("Expected one live verification token.");
        }
        const staleVerificationDigest = verificationRows.find(
          ({ invalidatedAt }) => invalidatedAt !== null,
        )?.tokenDigest;
        if (staleVerificationDigest === undefined) {
          throw new Error("Expected one superseded verification token.");
        }
        await expect(
          verification.consume(staleVerificationDigest),
        ).resolves.toEqual({ status: "INVALID" });

        const verificationAttempts = await Promise.all([
          verification.consume(liveVerificationDigest),
          verification.consume(liveVerificationDigest),
        ]);
        expect(
          verificationAttempts.filter(({ status }) => status === "VERIFIED"),
        ).toHaveLength(1);
        expect(
          verificationAttempts.filter(({ status }) => status === "INVALID"),
        ).toHaveLength(1);
        const verifiedCredential =
          await auth.findCredentialByNormalizedEmail(normalizedEmail);
        expect(verifiedCredential?.emailVerifiedAt).toBeInstanceOf(Date);
        await expect(
          verification.issue({
            expiresAt: verificationExpiry,
            tokenDigest: digest(`post-verified-${unique}`),
            userId: registration.user.id,
          }),
        ).resolves.toEqual({ status: "NOT_ELIGIBLE" });

        const phoneVerification = createPhoneVerificationRepository(sql);
        const phoneChallenges = [randomUUID(), randomUUID()];
        const phoneChallengeDigests = [
          digest(`phone-otp-a-${unique}`),
          digest(`phone-otp-b-${unique}`),
        ];
        const phoneSalts = [
          digest(`phone-salt-a-${unique}`).slice(0, 32),
          digest(`phone-salt-b-${unique}`).slice(0, 32),
        ];
        const phoneExpiry = new Date(Date.now() + 60_000);
        await expect(
          Promise.all(
            phoneChallenges.map((challengeId, index) =>
              phoneVerification.issue({
                challengeId,
                expiresAt: phoneExpiry,
                maxAttempts: 2,
                normalizedPhone: "+421901234567",
                otpDigest: phoneChallengeDigests[index]!,
                otpSalt: phoneSalts[index]!,
                userId: registration.user.id,
              }),
            ),
          ),
        ).resolves.toEqual([{ status: "ISSUED" }, { status: "ISSUED" }]);
        const [livePhoneChallenge] = await sql<
          {
            readonly id: string;
            readonly otpDigest: string;
            readonly otpSalt: string;
          }[]
        >`
          SELECT
            id,
            otp_digest AS "otpDigest",
            otp_salt AS "otpSalt"
          FROM phone_verification_challenges
          WHERE user_id = ${registration.user.id}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
        `;
        expect(livePhoneChallenge).toBeDefined();
        if (livePhoneChallenge === undefined) {
          throw new Error("Expected one live phone-verification challenge.");
        }
        const supersededPhoneChallenge = phoneChallenges.find(
          (challengeId) => challengeId !== livePhoneChallenge.id,
        );
        if (supersededPhoneChallenge === undefined) {
          throw new Error("Expected one superseded phone challenge.");
        }
        await expect(
          phoneVerification.findDigestMaterial({
            challengeId: supersededPhoneChallenge,
            userId: registration.user.id,
          }),
        ).resolves.toBeNull();

        const wrongDigest = digest(`wrong-phone-otp-${unique}`);
        await expect(
          phoneVerification.verifyAttempt({
            challengeId: livePhoneChallenge.id,
            otpDigest: wrongDigest,
            userId: registration.user.id,
          }),
        ).resolves.toEqual({ status: "INVALID" });
        await expect(
          phoneVerification.verifyAttempt({
            challengeId: livePhoneChallenge.id,
            otpDigest: wrongDigest,
            userId: registration.user.id,
          }),
        ).resolves.toEqual({ status: "INVALID" });
        await expect(
          phoneVerification.findDigestMaterial({
            challengeId: livePhoneChallenge.id,
            userId: registration.user.id,
          }),
        ).resolves.toBeNull();

        const successfulChallengeId = randomUUID();
        const successfulDigest = digest(`successful-phone-otp-${unique}`);
        await expect(
          phoneVerification.issue({
            challengeId: successfulChallengeId,
            expiresAt: phoneExpiry,
            maxAttempts: 5,
            normalizedPhone: "+421905765432",
            otpDigest: successfulDigest,
            otpSalt: digest(`successful-phone-salt-${unique}`).slice(0, 32),
            userId: registration.user.id,
          }),
        ).resolves.toEqual({ status: "ISSUED" });
        const phoneRace = await Promise.all([
          phoneVerification.verifyAttempt({
            challengeId: successfulChallengeId,
            otpDigest: successfulDigest,
            userId: registration.user.id,
          }),
          phoneVerification.verifyAttempt({
            challengeId: successfulChallengeId,
            otpDigest: successfulDigest,
            userId: registration.user.id,
          }),
        ]);
        expect(
          phoneRace.filter(({ status }) => status === "VERIFIED"),
        ).toHaveLength(1);
        expect(
          phoneRace.filter(({ status }) => status === "INVALID"),
        ).toHaveLength(1);
        const [phoneState] = await sql<
          { readonly normalizedPhone: string; readonly phoneVerifiedAt: Date }[]
        >`
          SELECT
            normalized_phone AS "normalizedPhone",
            phone_verified_at AS "phoneVerifiedAt"
          FROM auth_credentials
          WHERE user_id = ${registration.user.id}
        `;
        expect(phoneState?.normalizedPhone).toBe("+421905765432");
        expect(phoneState?.phoneVerifiedAt).toBeInstanceOf(Date);
        await expect(
          phoneVerification.issue({
            challengeId: randomUUID(),
            expiresAt: phoneExpiry,
            maxAttempts: 5,
            normalizedPhone: "+421905765432",
            otpDigest: digest(`same-verified-phone-${unique}`),
            otpSalt: digest(`same-verified-salt-${unique}`).slice(0, 32),
            userId: registration.user.id,
          }),
        ).resolves.toEqual({ status: "NOT_ELIGIBLE" });
        expect(credential).toMatchObject({
          id: registration.user.id,
          accountState: "ACTIVE",
          normalizedEmail,
          passwordHash: initialPasswordHash,
        });
        await expect(
          auth.findAuthUserById(registration.user.id),
        ).resolves.toMatchObject({
          id: registration.user.id,
          accountState: "ACTIVE",
        });

        const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
        const sessionDigests = [
          digest(`session-a-${unique}`),
          digest(`session-b-${unique}`),
        ];
        for (const sessionIdHash of sessionDigests) {
          await expect(
            auth.saveSession({
              sessionIdHash,
              userId: registration.user.id,
              payload: { userId: registration.user.id },
              expiresAt: sessionExpiresAt,
            }),
          ).resolves.toMatchObject({ sessionIdHash });
        }
        await expect(
          auth.findSession(sessionDigests[0]!),
        ).resolves.toMatchObject({ userId: registration.user.id });

        const competingTokenDigests = [
          digest(`reset-a-${unique}`),
          digest(`reset-b-${unique}`),
        ];
        await Promise.all(
          competingTokenDigests.map(async (tokenDigest) =>
            auth.createPasswordReset({
              userId: registration.user.id,
              tokenDigest,
              expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
            }),
          ),
        );
        const liveResetTokens = await sql<{ tokenDigest: string }[]>`
          SELECT token_digest AS "tokenDigest"
          FROM password_reset_tokens
          WHERE user_id = ${registration.user.id}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
        `;
        expect(liveResetTokens).toHaveLength(1);
        const tokenDigest = liveResetTokens[0]!.tokenDigest;

        const resetAttempts = await Promise.all([
          auth.consumePasswordReset(tokenDigest, replacementPasswordHash),
          auth.consumePasswordReset(tokenDigest, replacementPasswordHash),
        ]);
        expect(
          resetAttempts.filter(({ status }) => status === "SUCCESS"),
        ).toHaveLength(1);
        expect(
          resetAttempts.filter(({ status }) => status === "INVALID"),
        ).toHaveLength(1);
        expect(
          resetAttempts.find(({ status }) => status === "SUCCESS"),
        ).toMatchObject({
          revokedSessionCount: 2,
          status: "SUCCESS",
          userId: registration.user.id,
        });
        await expect(
          auth.consumePasswordReset(tokenDigest, replacementPasswordHash),
        ).resolves.toEqual({ status: "INVALID" });
        await expect(auth.findSession(sessionDigests[0]!)).resolves.toBeNull();
        await expect(auth.findSession(sessionDigests[1]!)).resolves.toBeNull();
        await expect(
          auth.findCredentialByNormalizedEmail(normalizedEmail),
        ).resolves.toMatchObject({ passwordHash: replacementPasswordHash });

        const rateInput = {
          scope: "login",
          keyDigest: digest(`rate-${unique}`),
          windowStartedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          limit: 3,
        } as const;
        const rateResults = await Promise.all([
          auth.consumeRateLimit(rateInput),
          auth.consumeRateLimit(rateInput),
          auth.consumeRateLimit(rateInput),
          auth.consumeRateLimit(rateInput),
        ]);
        expect(
          rateResults
            .map(({ attemptCount }) => attemptCount)
            .sort((a, b) => a - b),
        ).toEqual([1, 2, 3, 4]);
        expect(rateResults.filter(({ allowed }) => allowed)).toHaveLength(3);

        const media = createMediaRepository(sql);
        const mediaObjectKey = privateMediaKey(randomUUID());
        const mediaAsset = await media.createProcessingAsset({
          byteSize: 3,
          declaredContentType: "image/jpeg",
          displayFilename: "portfolio.jpg",
          kind: "IMAGE",
          ownerUserId: registration.user.id,
          provenanceEntityId: randomUUID(),
          provenanceEntityRevision: 1,
          provenanceEntityType: "PORTFOLIO_PROJECT",
          purpose: "PORTFOLIO_IMAGE",
          storageObject: {
            area: "private",
            key: mediaObjectKey,
          },
          uploaderUserId: registration.user.id,
        });
        expect(mediaAsset).toMatchObject({
          byteSize: 3,
          declaredContentType: "image/jpeg",
          displayFilename: "portfolio.jpg",
          kind: "IMAGE",
          ownerUserId: registration.user.id,
          provenanceEntityRevision: 1,
          provenanceEntityType: "PORTFOLIO_PROJECT",
          purpose: "PORTFOLIO_IMAGE",
          status: "PROCESSING",
          storageObject: { area: "private", key: mediaObjectKey },
          uploaderUserId: registration.user.id,
        });
        const [storedMediaObject] = await sql<
          { mediaAssetId: string; role: string; storageArea: string }[]
        >`
          SELECT
            media_asset_id AS "mediaAssetId",
            role,
            storage_area AS "storageArea"
          FROM media_asset_storage_objects
          WHERE media_asset_id = ${mediaAsset.id}
        `;
        expect(storedMediaObject).toEqual({
          mediaAssetId: mediaAsset.id,
          role: "ORIGINAL_UPLOAD",
          storageArea: "private",
        });
        await expect(
          media.findImageProcessingSource(mediaAsset.id),
        ).resolves.toMatchObject({
          declaredContentType: "image/jpeg",
          id: mediaAsset.id,
          kind: "IMAGE",
          originalStorageObject: { area: "private", key: mediaObjectKey },
          status: "PROCESSING",
        });
        const canonicalKey = privateMediaKey(randomUUID());
        const thumbnailKey = privateMediaKey(randomUUID());
        await expect(
          media.completeImageProcessing({
            assetId: mediaAsset.id,
            canonicalHeight: 800,
            canonicalWidth: 1200,
            capturedAt: new Date("2026-09-14T10:30:00.000Z"),
            derivatives: [
              {
                byteSize: 10,
                contentSha256: digest(`canonical-${unique}`),
                contentType: "image/webp",
                role: "CANONICAL",
                storageObject: { area: "private", key: canonicalKey },
              },
              {
                byteSize: 5,
                contentSha256: digest(`thumbnail-${unique}`),
                contentType: "image/webp",
                role: "THUMBNAIL",
                storageObject: { area: "private", key: thumbnailKey },
              },
            ],
          }),
        ).resolves.toEqual({ transition: "UPDATED" });
        await expect(
          media.completeImageProcessing({
            assetId: mediaAsset.id,
            canonicalHeight: 800,
            canonicalWidth: 1200,
            capturedAt: null,
            derivatives: [
              {
                byteSize: 10,
                contentSha256: digest(`unused-canonical-${unique}`),
                contentType: "image/webp",
                role: "CANONICAL",
                storageObject: {
                  area: "private",
                  key: privateMediaKey(randomUUID()),
                },
              },
              {
                byteSize: 5,
                contentSha256: digest(`unused-thumbnail-${unique}`),
                contentType: "image/webp",
                role: "THUMBNAIL",
                storageObject: {
                  area: "private",
                  key: privateMediaKey(randomUUID()),
                },
              },
            ],
          }),
        ).resolves.toEqual({ transition: "ALREADY_READY" });
        const imageRows = await sql<
          {
            canonicalHeight: number;
            canonicalWidth: number;
            capturedAt: Date;
            role: string;
            storageKey: string;
          }[]
        >`
          SELECT
            asset.canonical_height AS "canonicalHeight",
            asset.canonical_width AS "canonicalWidth",
            asset.captured_at AS "capturedAt",
            object.role,
            object.storage_key AS "storageKey"
          FROM media_assets AS asset
          INNER JOIN media_asset_storage_objects AS object
            ON object.media_asset_id = asset.id
          WHERE asset.id = ${mediaAsset.id}
          ORDER BY object.role
        `;
        expect(imageRows).toHaveLength(3);
        expect(imageRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "CANONICAL",
              storageKey: canonicalKey,
            }),
            expect.objectContaining({
              role: "THUMBNAIL",
              storageKey: thumbnailKey,
            }),
          ]),
        );
        expect(imageRows[0]).toMatchObject({
          canonicalHeight: 800,
          canonicalWidth: 1200,
          capturedAt: new Date("2026-09-14T10:30:00.000Z"),
        });
        const privateMediaDelivery = createPrivateMediaDeliveryRepository(sql);
        await expect(
          privateMediaDelivery.loadPrivateDeliverySnapshot({
            actorUserId: registration.user.id,
            mediaAssetId: mediaAsset.id,
          }),
        ).resolves.toMatchObject({
          actor: {
            accountState: "ACTIVE",
            userId: registration.user.id,
          },
          asset: {
            id: mediaAsset.id,
            ownerUserId: registration.user.id,
            status: "READY",
          },
          object: {
            contentType: "image/webp",
            revokedAt: null,
            role: "CANONICAL",
            storageObject: { area: "private", key: canonicalKey },
          },
        });
        const [suspendedMediaActor] = await sql<{ id: string }[]>`
          INSERT INTO users (account_state)
          VALUES ('SUSPENDED')
          RETURNING id
        `;
        await expect(
          privateMediaDelivery.loadPrivateDeliverySnapshot({
            actorUserId: suspendedMediaActor!.id,
            mediaAssetId: mediaAsset.id,
          }),
        ).resolves.toMatchObject({
          actor: {
            accountState: "SUSPENDED",
            userId: suspendedMediaActor!.id,
          },
        });
        await expect(
          media.recordMediaProcessingRejected({
            assetId: mediaAsset.id,
            rejectionCode: "MALWARE_DETECTED",
          }),
        ).resolves.toEqual({ transition: "NOT_PROCESSING" });

        const rejectedAsset = await media.createProcessingAsset({
          byteSize: 4,
          declaredContentType: "application/pdf",
          displayFilename: "evidence.pdf",
          kind: "DOCUMENT",
          ownerUserId: registration.user.id,
          provenanceEntityId: null,
          provenanceEntityRevision: null,
          provenanceEntityType: null,
          purpose: "JOB_DOCUMENT",
          storageObject: {
            area: "private",
            key: privateMediaKey(randomUUID()),
          },
          uploaderUserId: registration.user.id,
        });
        await expect(
          media.recordMediaProcessingRejected({
            assetId: rejectedAsset.id,
            rejectionCode: "SIGNATURE_MISMATCH",
          }),
        ).resolves.toMatchObject({
          assetId: rejectedAsset.id,
          rejectionCode: "SIGNATURE_MISMATCH",
          status: "REJECTED",
          transition: "UPDATED",
        });
        await expect(
          media.recordMediaProcessingSucceeded(rejectedAsset.id),
        ).resolves.toEqual({ transition: "NOT_PROCESSING" });

        const documentAsset = await media.createProcessingAsset({
          byteSize: 128,
          declaredContentType: "application/pdf",
          displayFilename: "quote.pdf",
          kind: "DOCUMENT",
          ownerUserId: registration.user.id,
          provenanceEntityId: randomUUID(),
          provenanceEntityRevision: 1,
          provenanceEntityType: "JOB",
          purpose: "JOB_DOCUMENT",
          storageObject: {
            area: "private",
            key: privateMediaKey(randomUUID()),
          },
          uploaderUserId: registration.user.id,
        });
        await expect(
          media.findDocumentProcessingSource(documentAsset.id),
        ).resolves.toMatchObject({
          declaredContentType: "application/pdf",
          id: documentAsset.id,
          kind: "DOCUMENT",
          status: "PROCESSING",
        });
        const documentContentSha256 = digest(`document-${unique}`);
        const documentScannedAt = new Date();
        await expect(
          media.completeDocumentProcessing({
            assetId: documentAsset.id,
            canonical: {
              byteSize: 128,
              contentSha256: documentContentSha256,
              contentType: "application/pdf",
              role: "CANONICAL",
              storageObject: {
                area: "private",
                key: privateMediaKey(randomUUID()),
              },
            },
            pageCount: 2,
            scan: {
              assurance: "ACTIVE",
              contentSha256: documentContentSha256,
              engine: "integration-scanner",
              engineVersion: "1.0.0",
              scannedAt: documentScannedAt,
              signatureVersion: "20260914.1",
              verdict: "CLEAN",
            },
          }),
        ).resolves.toEqual({ transition: "UPDATED" });
        const [readyDocument] = await sql<
          {
            documentContentSha256: string;
            documentPageCount: number;
            malwareScanVerdict: string;
            malwareScannedAt: Date;
          }[]
        >`
          SELECT
            document_content_sha256 AS "documentContentSha256",
            document_page_count AS "documentPageCount",
            malware_scan_verdict AS "malwareScanVerdict",
            malware_scanned_at AS "malwareScannedAt"
          FROM media_assets
          WHERE id = ${documentAsset.id}
        `;
        expect(readyDocument).toEqual({
          documentContentSha256,
          documentPageCount: 2,
          malwareScanVerdict: "CLEAN",
          malwareScannedAt: documentScannedAt,
        });
        await expect(
          media.completeDocumentProcessing({
            assetId: documentAsset.id,
            canonical: {
              byteSize: 128,
              contentSha256: digest(`unused-document-${unique}`),
              contentType: "application/pdf",
              role: "CANONICAL",
              storageObject: {
                area: "private",
                key: privateMediaKey(randomUUID()),
              },
            },
            pageCount: 1,
            scan: {
              assurance: "ACTIVE",
              contentSha256: digest(`unused-document-${unique}`),
              engine: "integration-scanner",
              engineVersion: "1.0.0",
              scannedAt: new Date(),
              signatureVersion: "20260914.1",
              verdict: "CLEAN",
            },
          }),
        ).resolves.toEqual({ transition: "ALREADY_READY" });

        const unscannedDocument = await media.createProcessingAsset({
          byteSize: 64,
          declaredContentType: "application/pdf",
          displayFilename: null,
          kind: "DOCUMENT",
          ownerUserId: registration.user.id,
          provenanceEntityId: null,
          provenanceEntityRevision: null,
          provenanceEntityType: null,
          purpose: "JOB_DOCUMENT",
          storageObject: {
            area: "private",
            key: privateMediaKey(randomUUID()),
          },
          uploaderUserId: registration.user.id,
        });
        await expect(sql`
          UPDATE media_assets
          SET status = 'READY', ready_at = CURRENT_TIMESTAMP
          WHERE id = ${unscannedDocument.id}
        `).rejects.toThrow();
        await expect(
          media.recordMediaProcessingSucceeded("../../another-asset"),
        ).resolves.toEqual({ transition: "NOT_PROCESSING" });
        await expect(
          media.recordMediaProcessingRejected({
            assetId: randomUUID(),
            rejectionCode: "not safe/details.pdf",
          }),
        ).rejects.toThrow(/stable safe identifier/u);

        await expect(
          media.createProcessingAsset({
            byteSize: 1,
            declaredContentType: "image/png",
            displayFilename: null,
            kind: "IMAGE",
            ownerUserId: registration.user.id,
            provenanceEntityId: null,
            provenanceEntityRevision: null,
            provenanceEntityType: null,
            purpose: "PROFILE_IMAGE",
            storageObject: {
              area: "public-derivative",
              key: `public-derivative/2026/09/${randomUUID()}` as CreateProcessingMediaAssetInput["storageObject"]["key"],
            },
            uploaderUserId: registration.user.id,
          }),
        ).rejects.toThrow(/private processing storage/u);
        await expect(
          sql`
            INSERT INTO media_assets (
              owner_user_id,
              uploaded_by_user_id,
              kind,
              purpose,
              declared_content_type,
              display_filename,
              byte_size
            ) VALUES (
              ${registration.user.id},
              ${registration.user.id},
              'IMAGE',
              'PROFILE_IMAGE',
              'image/png',
              '../../unsafe.png',
              1
            )
          `,
        ).rejects.toThrow(/media_assets_display_filename_bounded/u);
        await expect(
          sql`
            INSERT INTO media_asset_storage_objects (
              media_asset_id,
              role,
              storage_area,
              storage_key,
              content_type,
              byte_size
            ) VALUES (
              ${mediaAsset.id},
              'CANONICAL',
              'private',
              '../../guessable-client-path',
              'image/webp',
              1
            )
          `,
        ).rejects.toThrow(/media_asset_storage_objects_key_matches_area/u);

        const outbox = createOutboxRepository(sql);
        const committedEventId = randomUUID();
        const committedUserId = randomUUID();
        const committedEvent = integrationEventDefinition.create({
          entity: { id: committedUserId, type: "USER" },
          eventId: committedEventId,
          idempotencyKey: `integration:${committedEventId}`,
          occurredAt: new Date(),
          payload: { entity_id: committedUserId, outcome: "CREATED" },
        });
        await outbox.transactions.run(async (transaction) => {
          await transaction`
            INSERT INTO users (id)
            VALUES (${committedUserId})
          `;
          await outbox.writer.collect(transaction, [committedEvent], {
            commandName: "integration.create",
            correlationId: randomUUID(),
          });
        });
        const [atomicCommit] = await sql<
          { eventCount: number; userCount: number }[]
        >`
          SELECT
            (SELECT count(*)::integer FROM users WHERE id = ${committedUserId}) AS "userCount",
            (
              SELECT count(*)::integer
              FROM domain_outbox_events
              WHERE event_id = ${committedEventId}
            ) AS "eventCount"
        `;
        expect(atomicCommit).toEqual({ eventCount: 1, userCount: 1 });

        const rolledBackEventId = randomUUID();
        const rolledBackUserId = randomUUID();
        const rolledBackEvent = integrationEventDefinition.create({
          eventId: rolledBackEventId,
          idempotencyKey: `integration:${rolledBackEventId}`,
          occurredAt: new Date(),
          payload: { entity_id: rolledBackUserId, outcome: "ROLLED_BACK" },
        });
        await expect(
          outbox.transactions.run(async (transaction) => {
            await transaction`
              INSERT INTO users (id)
              VALUES (${rolledBackUserId})
            `;
            await outbox.writer.collect(transaction, [rolledBackEvent], {
              commandName: "integration.rollback",
              correlationId: randomUUID(),
            });
            throw new Error("intentional rollback");
          }),
        ).rejects.toThrow("intentional rollback");
        const [atomicRollback] = await sql<
          { eventCount: number; userCount: number }[]
        >`
          SELECT
            (SELECT count(*)::integer FROM users WHERE id = ${rolledBackUserId}) AS "userCount",
            (
              SELECT count(*)::integer
              FROM domain_outbox_events
              WHERE event_id = ${rolledBackEventId}
            ) AS "eventCount"
        `;
        expect(atomicRollback).toEqual({ eventCount: 0, userCount: 0 });

        const beforeClaim = await outbox.snapshot();
        expect(beforeClaim).toMatchObject({ backlog: 1, pending: 1 });
        expect(beforeClaim.oldestBacklogAgeMs).toBeGreaterThanOrEqual(0);
        const competingClaims = await Promise.all([
          outbox.claimNext({ leaseDurationMs: 60_000, now: new Date() }),
          outbox.claimNext({ leaseDurationMs: 60_000, now: new Date() }),
        ]);
        const firstDelivery = competingClaims.find(
          (delivery) => delivery !== undefined,
        );
        expect(firstDelivery).toMatchObject({
          attempt: 1,
          event: { eventId: committedEventId },
        });
        expect(
          competingClaims.filter((delivery) => delivery === undefined),
        ).toHaveLength(1);
        if (firstDelivery === undefined) {
          throw new Error("Expected one race-safe outbox claim.");
        }

        await sql`
          UPDATE domain_outbox_events
          SET
            updated_at = created_at,
            lease_expires_at = created_at + interval '1 microsecond'
          WHERE event_id = ${committedEventId}
        `;
        const reclaimedDelivery = await outbox.claimNext({
          leaseDurationMs: 60_000,
          now: new Date(),
        });
        expect(reclaimedDelivery).toMatchObject({
          attempt: 2,
          event: { eventId: committedEventId },
        });
        if (reclaimedDelivery === undefined) {
          throw new Error("Expected expired outbox lease to be reclaimed.");
        }
        await expect(
          outbox.markPublished(firstDelivery, new Date()),
        ).resolves.toBe(false);
        await expect(
          outbox.markPublished(reclaimedDelivery, new Date()),
        ).resolves.toBe(true);
        await expect(outbox.snapshot()).resolves.toMatchObject({
          backlog: 0,
          pending: 0,
          processing: 0,
        });

        const consumerEffectUserId = randomUUID();
        const consumer = createIdempotentConsumer({
          claims: outbox.consumerClaims,
          transactions: outbox.transactions,
        });
        const applyConsumerEffect = async () =>
          consumer.applyOnce(
            { consumerName: "integration.consumer", eventId: committedEventId },
            async (transaction) => {
              await transaction`
                INSERT INTO users (id)
                VALUES (${consumerEffectUserId})
              `;
              return consumerEffectUserId;
            },
          );
        await expect(applyConsumerEffect()).resolves.toEqual({
          disposition: "APPLIED",
          result: consumerEffectUserId,
        });
        await expect(applyConsumerEffect()).resolves.toEqual({
          disposition: "DUPLICATE",
        });
        const [consumerEffectCount] = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM users
          WHERE id = ${consumerEffectUserId}
        `;
        expect(consumerEffectCount?.count).toBe(1);

        await expect(sql`
          INSERT INTO domain_outbox_events (
            event_id,
            idempotency_key,
            event_name,
            schema_version,
            occurred_at,
            payload,
            command_name,
            correlation_id
          ) VALUES (
            ${randomUUID()},
            ${`unsafe:${randomUUID()}`},
            'integration.unsafe',
            1,
            CURRENT_TIMESTAMP,
            ${sql.json({ entity: { wholeBusinessObject: true } })},
            'integration.unsafe',
            ${randomUUID()}
          )
        `).rejects.toThrow(/domain_outbox_events_payload_object_bounded/u);

        await Promise.all(
          ["person@example.test", "full sentence dumped here"].map(
            async (unsafeValue) => {
              await expect(sql`
                INSERT INTO domain_outbox_events (
                  event_id,
                  idempotency_key,
                  event_name,
                  schema_version,
                  occurred_at,
                  payload,
                  command_name,
                  correlation_id
                ) VALUES (
                  ${randomUUID()},
                  ${`unsafe-payload:${randomUUID()}`},
                  'integration.unsafe_payload',
                  1,
                  CURRENT_TIMESTAMP,
                  ${sql.json({ outcome: unsafeValue })},
                  'integration.unsafe_payload',
                  ${randomUUID()}
                )
              `).rejects.toThrow(
                /domain_outbox_events_payload_object_bounded/u,
              );
            },
          ),
        );

        const unsafeEnvelopeCases = [
          {
            correlationId: randomUUID(),
            entityId: randomUUID(),
            idempotencyKey: "person@example.test",
          },
          {
            correlationId: "Bearer eyJhbGciOiJIUzI1NiJ9",
            entityId: randomUUID(),
            idempotencyKey: `unsafe-envelope:${randomUUID()}`,
          },
          {
            correlationId: randomUUID(),
            entityId: "owner@example.test",
            idempotencyKey: `unsafe-envelope:${randomUUID()}`,
          },
        ];
        await Promise.all(
          unsafeEnvelopeCases.map(
            async ({ correlationId, entityId, idempotencyKey }) => {
              await expect(sql`
                INSERT INTO domain_outbox_events (
                  event_id,
                  idempotency_key,
                  event_name,
                  schema_version,
                  occurred_at,
                  entity_type,
                  entity_id,
                  payload,
                  command_name,
                  correlation_id
                ) VALUES (
                  ${randomUUID()},
                  ${idempotencyKey},
                  'integration.unsafe_envelope',
                  1,
                  CURRENT_TIMESTAMP,
                  'USER',
                  ${entityId},
                  ${sql.json({ outcome: "REJECTED" })},
                  'integration.unsafe_envelope',
                  ${correlationId}
                )
              `).rejects.toThrow(/domain_outbox_events_/u);
            },
          ),
        );

        const adminAccess = createAdminAccessRepository(sql);
        const superAdminId = randomUUID() as UserId;
        const adminId = randomUUID() as UserId;
        const targetId = randomUUID() as UserId;
        await sql`
          INSERT INTO users (id)
          VALUES (${superAdminId}), (${adminId}), (${targetId})
        `;
        await sql`
          INSERT INTO admin_role_grants (
            user_id,
            role,
            grant_source,
            reason
          ) VALUES
            (${superAdminId}, 'SUPER_ADMIN', 'BOOTSTRAP', 'Synthetic integration bootstrap'),
            (${adminId}, 'ADMIN', 'BOOTSTRAP', 'Synthetic integration bootstrap')
        `;
        const [superFactor] = await sql<{ id: string }[]>`
          INSERT INTO admin_mfa_factors (
            user_id,
            kind,
            credential_reference,
            display_label
          ) VALUES (
            ${superAdminId},
            'TOTP',
            ${`test-provider:credential:${randomUUID()}`},
            'Integration factor'
          )
          RETURNING id
        `;
        const [adminFactor] = await sql<{ id: string }[]>`
          INSERT INTO admin_mfa_factors (
            user_id,
            kind,
            credential_reference
          ) VALUES (
            ${adminId},
            'WEBAUTHN',
            ${`test-provider:credential:${randomUUID()}`}
          )
          RETURNING id
        `;
        if (superFactor === undefined || adminFactor === undefined) {
          throw new Error("Expected integration MFA factors.");
        }
        const superSessionDigest = digest(`super-session-${randomUUID()}`);
        const adminSessionDigest = digest(`admin-session-${randomUUID()}`);
        const privilegedExpiresAt = new Date(Date.now() + 30 * 60_000);
        await sql`
          INSERT INTO auth_sessions (
            session_id_hash,
            user_id,
            payload,
            expires_at
          ) VALUES
            (${superSessionDigest}, ${superAdminId}, ${sql.json({})}, ${privilegedExpiresAt}),
            (${adminSessionDigest}, ${adminId}, ${sql.json({})}, ${privilegedExpiresAt})
        `;
        await sql`
          INSERT INTO admin_privileged_sessions (
            session_id_hash,
            user_id,
            mfa_factor_id,
            mfa_authenticated_at,
            expires_at
          ) VALUES (
            ${adminSessionDigest},
            ${adminId},
            ${adminFactor.id},
            CURRENT_TIMESTAMP,
            ${privilegedExpiresAt}
          )
        `;

        await expect(
          adminAccess.findPrivilegedIdentity(superAdminId),
        ).resolves.toMatchObject({
          factors: [
            expect.objectContaining({
              factorId: superFactor.id,
              kind: "TOTP",
            }),
          ],
          roles: ["SUPER_ADMIN"],
          userId: superAdminId,
        });

        const challengeDigest = digest(`admin-mfa-${randomUUID()}`);
        await expect(
          adminAccess.createMfaChallenge({
            challengeDigest,
            expiresAt: new Date(Date.now() + 120_000),
            factorId: superFactor.id,
            providerStateReference: `test-provider:state:${randomUUID()}`,
            purpose: "PRIVILEGED_SESSION",
            userId: superAdminId,
          }),
        ).resolves.toBe(true);
        const concurrentClaims = await Promise.all([
          adminAccess.claimMfaChallenge({
            challengeDigest,
            now: new Date(),
            userId: superAdminId,
          }),
          adminAccess.claimMfaChallenge({
            challengeDigest,
            now: new Date(),
            userId: superAdminId,
          }),
        ]);
        expect(concurrentClaims.filter(Boolean)).toHaveLength(1);
        expect(concurrentClaims.find(Boolean)).toMatchObject({
          factorId: superFactor.id,
          kind: "TOTP",
          userId: superAdminId,
        });
        await expect(
          adminAccess.completeMfaChallenge({
            challengeDigest,
            expiresAt: privilegedExpiresAt,
            now: new Date(),
            sessionIdDigest: superSessionDigest,
            userId: superAdminId,
          }),
        ).resolves.toBe(true);
        await expect(
          adminAccess.completeMfaChallenge({
            challengeDigest,
            expiresAt: privilegedExpiresAt,
            now: new Date(),
            sessionIdDigest: superSessionDigest,
            userId: superAdminId,
          }),
        ).resolves.toBe(false);
        await expect(
          adminAccess.findPrivilegedSession({
            now: new Date(),
            sessionIdDigest: superSessionDigest,
            userId: superAdminId,
          }),
        ).resolves.toMatchObject({ roles: ["SUPER_ADMIN"] });
        await expect(
          adminAccess.findPrivilegedSession({
            now: new Date(privilegedExpiresAt.valueOf() + 1),
            sessionIdDigest: superSessionDigest,
            userId: superAdminId,
          }),
        ).resolves.toBeUndefined();

        const staleChallengeDigest = digest(`expired-mfa-${randomUUID()}`);
        await sql`
          INSERT INTO admin_mfa_challenges (
            challenge_digest,
            user_id,
            factor_id,
            purpose,
            created_at,
            expires_at
          ) VALUES (
            ${staleChallengeDigest},
            ${superAdminId},
            ${superFactor.id},
            'PRIVILEGED_SESSION',
            CURRENT_TIMESTAMP - interval '2 minutes',
            CURRENT_TIMESTAMP - interval '1 minute'
          )
        `;
        await expect(
          adminAccess.claimMfaChallenge({
            challengeDigest: staleChallengeDigest,
            now: new Date(),
            userId: superAdminId,
          }),
        ).resolves.toBeUndefined();

        const roleEventId = randomUUID();
        const roleChange = await adminAccess.changeRole({
          action: "GRANT",
          actorSessionIdDigest: superSessionDigest,
          actorUserId: superAdminId,
          eventId: roleEventId,
          reason: "Approved integration superadmin grant",
          reauthenticationMaxAgeMs: 5 * 60_000,
          role: "SUPER_ADMIN",
          targetUserId: targetId,
        });
        expect(roleChange).toMatchObject({
          action: "ADMIN_ROLE_GRANTED",
          eventId: roleEventId,
          targetUserId: targetId,
        });
        const [mirroredRoleAudit] = await sql<
          {
            action: string;
            sourceEventId: string;
            occurredAt: Date;
          }[]
        >`
          SELECT
            action_type AS action,
            source_admin_role_change_event_id AS "sourceEventId",
            occurred_at AS "occurredAt"
          FROM audit_events
          WHERE event_id = ${roleEventId}
        `;
        expect(mirroredRoleAudit).toMatchObject({
          action: "admin.role.granted",
          sourceEventId: roleEventId,
        });
        expect(mirroredRoleAudit?.occurredAt).toEqual(roleChange?.occurredAt);

        const unsafeRoleReasons = [
          "Contact owner@example.test before granting role",
          "Review https://private.test/admin-case before granting role",
          "Bearer abc.def.credential must never enter audit history",
          "Call +421 900 111 222 before granting role",
        ];
        for (const reason of unsafeRoleReasons) {
          const unsafeTargetId = randomUUID() as UserId;
          const unsafeEventId = randomUUID();
          await sql`INSERT INTO users (id) VALUES (${unsafeTargetId})`;
          await expect(
            adminAccess.changeRole({
              action: "GRANT",
              actorSessionIdDigest: superSessionDigest,
              actorUserId: superAdminId,
              eventId: unsafeEventId,
              reason,
              reauthenticationMaxAgeMs: 5 * 60_000,
              role: "ADMIN",
              targetUserId: unsafeTargetId,
            }),
          ).rejects.toThrow();
          const [unsafeRoleMutation] = await sql<{ count: number }[]>`
            SELECT count(*)::integer AS count
            FROM admin_role_grants
            WHERE user_id = ${unsafeTargetId}
              AND role = 'ADMIN'
              AND revoked_at IS NULL
          `;
          const [unsafeAuditMutation] = await sql<{ count: number }[]>`
            SELECT count(*)::integer AS count
            FROM audit_events
            WHERE event_id = ${unsafeEventId}
          `;
          const [unsafeSourceEvent] = await sql<{ count: number }[]>`
            SELECT count(*)::integer AS count
            FROM admin_role_change_events
            WHERE event_id = ${unsafeEventId}
          `;
          expect(unsafeRoleMutation?.count).toBe(0);
          expect(unsafeAuditMutation?.count).toBe(0);
          expect(unsafeSourceEvent?.count).toBe(0);
        }
        await expect(
          adminAccess.changeRole({
            action: "GRANT",
            actorSessionIdDigest: adminSessionDigest,
            actorUserId: adminId,
            eventId: randomUUID(),
            reason: "Unauthorized integration role grant",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "ADMIN",
            targetUserId: targetId,
          }),
        ).resolves.toBeUndefined();

        await sql`
          UPDATE admin_privileged_sessions
          SET mfa_authenticated_at = CURRENT_TIMESTAMP - interval '6 minutes'
          WHERE session_id_hash = ${superSessionDigest}
        `;
        await expect(
          adminAccess.changeRole({
            action: "GRANT",
            actorSessionIdDigest: superSessionDigest,
            actorUserId: superAdminId,
            eventId: randomUUID(),
            reason: "Stale privileged authentication denied",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "ADMIN",
            targetUserId: targetId,
          }),
        ).resolves.toBeUndefined();
        await sql`
          UPDATE admin_privileged_sessions
          SET mfa_authenticated_at = created_at
          WHERE session_id_hash = ${superSessionDigest}
        `;
        await sql`
          UPDATE admin_mfa_factors
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE id = ${superFactor.id}
        `;
        await expect(
          adminAccess.changeRole({
            action: "GRANT",
            actorSessionIdDigest: superSessionDigest,
            actorUserId: superAdminId,
            eventId: randomUUID(),
            reason: "Revoked authentication factor denied",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "ADMIN",
            targetUserId: targetId,
          }),
        ).resolves.toBeUndefined();
        await sql`
          UPDATE admin_mfa_factors
          SET revoked_at = NULL
          WHERE id = ${superFactor.id}
        `;
        await expect(
          adminAccess.changeRole({
            action: "GRANT",
            actorSessionIdDigest: superSessionDigest,
            actorUserId: superAdminId,
            eventId: randomUUID(),
            reason: "Forbidden integration self grant",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "ADMIN",
            targetUserId: superAdminId,
          }),
        ).resolves.toBeUndefined();

        const targetSessionDigest = digest(`target-session-${randomUUID()}`);
        const [targetFactor] = await sql<{ id: string }[]>`
          INSERT INTO admin_mfa_factors (
            user_id,
            kind,
            credential_reference
          ) VALUES (
            ${targetId},
            'TOTP',
            ${`test-provider:credential:${randomUUID()}`}
          )
          RETURNING id
        `;
        if (targetFactor === undefined) {
          throw new Error("Expected target MFA factor.");
        }
        await sql`
          INSERT INTO auth_sessions (
            session_id_hash,
            user_id,
            payload,
            expires_at
          ) VALUES (
            ${targetSessionDigest},
            ${targetId},
            ${sql.json({})},
            ${privilegedExpiresAt}
          )
        `;
        await sql`
          INSERT INTO admin_privileged_sessions (
            session_id_hash,
            user_id,
            mfa_factor_id,
            mfa_authenticated_at,
            expires_at
          ) VALUES (
            ${targetSessionDigest},
            ${targetId},
            ${targetFactor.id},
            CURRENT_TIMESTAMP,
            ${privilegedExpiresAt}
          )
        `;
        await expect(
          adminAccess.changeRole({
            action: "GRANT",
            actorSessionIdDigest: superSessionDigest,
            actorUserId: superAdminId,
            eventId: randomUUID(),
            reason: "Grant revokes stale target privilege",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "ADMIN",
            targetUserId: targetId,
          }),
        ).resolves.toMatchObject({ action: "ADMIN_ROLE_GRANTED" });
        await expect(
          adminAccess.findPrivilegedSession({
            now: new Date(),
            sessionIdDigest: targetSessionDigest,
            userId: targetId,
          }),
        ).resolves.toBeUndefined();

        await expect(
          adminAccess.changeRole({
            action: "REVOKE",
            actorSessionIdDigest: superSessionDigest,
            actorUserId: superAdminId,
            eventId: roleEventId,
            reason: "Duplicate event forces transaction rollback",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "SUPER_ADMIN",
            targetUserId: targetId,
          }),
        ).rejects.toThrow();
        const [rolledBackGrant] = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM admin_role_grants
          WHERE user_id = ${targetId}
            AND role = 'SUPER_ADMIN'
            AND revoked_at IS NULL
        `;
        expect(rolledBackGrant?.count).toBe(1);
        await expect(sql`
          UPDATE admin_role_change_events
          SET reason = 'Forbidden audit rewrite'
          WHERE event_id = ${roleEventId}
        `).rejects.toThrow(/append-only/u);

        const service = createAdminAccessService({
          challengeTtlMs: 120_000,
          clock: () => new Date(),
          mfaProvider: {
            begin: () =>
              Promise.resolve({
                providerStateReference: null,
                publicChallenge: null,
              }),
            verify: () => Promise.resolve(false),
          },
          privilegedSessionTtlMs: 30 * 60_000,
          reauthenticationMaxAgeMs: 5 * 60_000,
          repository: adminAccess,
        });
        await expect(
          service.changeRole({
            action: "GRANT",
            actorSessionId: "not-the-live-session-secret",
            actorUserId: superAdminId,
            reason: "Missing privileged session is denied",
            role: "ADMIN",
            targetUserId: targetId,
          }),
        ).resolves.toEqual({ status: "AUTHORIZATION_DENIED" });

        await runAuditIntegrationAssertions(sql, superAdminId);
        await runPrivacyIntegrationAssertions(sql);
        await runTaxonomyIntegrationAssertions(sql);
        await runCustomerProfileIntegrationAssertions(sql);
        await runCraftsmanProfileIntegrationAssertions(sql);
        await runCraftsmanProfessionIntegrationAssertions(sql);
        await runCraftsmanCapabilityIntegrationAssertions(sql);
        await runCraftsmanServiceAreaIntegrationAssertions(sql);
        await expect(
          createMunicipalityAutocompleteRepository(sql).suggest("Testovacia"),
        ).resolves.toContainEqual(
          expect.objectContaining({ code: "TEST:MUNICIPALITY_BASE" }),
        );
        await runIndicativePricingIntegrationAssertions(sql);
        await runCraftsmanExperienceIntegrationAssertions(sql);
        await runCraftsmanAvailabilityIntegrationAssertions(sql);
        await runPortfolioProjectIntegrationAssertions(sql);
        await runCredentialClaimIntegrationAssertions(sql);
        await runCraftsmanPublicationIntegrationAssertions(sql);
        await runPortfolioProjectMediaIntegrationAssertions(sql);
        await runPortfolioCollaborationIntegrationAssertions(sql);
        await runFeaturedProjectIntegrationAssertions(sql);
        await runPortfolioPublicationIntegrationAssertions(sql);
        await runR1SupplySideIntegrationAssertions(sql);
        await runPublicSearchCardIntegrationAssertions(sql);
        await createTaxonomyAutocompleteRepository(sql).findCandidates({
          limit: 10,
          normalizedText: "test",
          tokens: ["test"],
        });
        await runCraftsmanDistanceIntegrationAssertions(sql);
        await runCraftsmanServiceAreaMatchIntegrationAssertions(sql);
        await runCraftsmanAvailabilityMatchIntegrationAssertions(sql);
        await runCraftsmanTrustEvidenceIntegrationAssertions(sql);
        await runCustomerShortlistIntegrationAssertions(sql);
        await runJobRequestIntegrationAssertions(sql);
        await runJobRequestDraftIntegrationAssertions(sql);
        await runJobRequestContentIntegrationAssertions(sql);
        await runJobRequestVersionIntegrationAssertions(sql);
        await runNotificationIntegrationAssertions(sql);
        await runJobInvitationIntegrationAssertions(sql);
        await runJobInvitationNotificationIntegrationAssertions(sql);
        await runConversationIntegrationAssertions(sql);
        await runConversationChatIntegrationAssertions(sql);
        await runConversationMessagePolicyIntegrationAssertions(sql);
        await runConversationAttachmentIntegrationAssertions(sql);
        await runQuoteIntegrationAssertions(sql);
        await runStructuredQuoteIntegrationAssertions(sql);
        await runQuoteComparisonIntegrationAssertions(
          sql,
          "PLATFORM_STRUCTURED",
        );
        await runExternalPdfQuoteIntegrationAssertions(sql);
        await runR3DemandSideSecurityIntegrationAssertions(sql);
        await runJobAcceptanceIdentityIntegrationAssertions(sql);
        const acceptanceSource =
          await runQuoteAcceptanceRepositoryIntegrationAssertions(sql);
        await runQuoteLifecycleIntegrationAssertions(sql);
        await runDemandSideNotificationIntegrationAssertions(sql);
        await runR3AnalyticsIntegrationAssertions(sql);
        await runJobRequestLifecycleIntegrationAssertions(sql);
        await runR3AnalyticsPostLifecycleAssertions(sql);
        await runConversationReadOnlyIntegrationAssertions(sql);
        await runConversationChatReadOnlyIntegrationAssertions(sql);
        await runMediaProcessingQueueIntegrationAssertions(sql);
        await runQuoteAcceptanceCommittedRaceIntegrationAssertions(
          sql,
          acceptanceSource,
        );
        await runJobRosterIdentityIntegrationAssertions(sql);
        await runJobRosterReadIntegrationAssertions(sql);
        await runJobParticipationCommandsIntegrationAssertions(sql);
        await runJobParticipantCapabilityIntegrationAssertions(sql);
        await runVerifiedCompletionEvidenceIntegrationAssertions(sql);
        await runJobOperationalIntegrationAssertions(sql);
        await runJobOperationalMediaIntegrationAssertions(sql);
        await runJobMilestoneIntegrationAssertions(sql);
        await runJobMilestoneContextIntegrationAssertions(sql);
        await runChangeOrderIntegrationAssertions(sql);
        await runChangeOrderPdfIntegrationAssertions(sql);
        await runJobCompletionIntegrationAssertions(sql);
        await runMainBilateralReviewIntegrationAssertions(sql);
        await runJobLifecycleIntegrationAssertions(sql);
        await runJobRosterCancelledIntegrationAssertions(sql);
        await runJobRosterCancelledReadIntegrationAssertions(sql);
        await runJobDocumentationIntegrationAssertions(sql);

        await adminAccess.revokePrivilegedSession(superSessionDigest);
        await expect(
          adminAccess.findPrivilegedSession({
            now: new Date(),
            sessionIdDigest: superSessionDigest,
            userId: superAdminId,
          }),
        ).resolves.toBeUndefined();
        await sql`
          UPDATE users
          SET account_state = 'SUSPENDED',
              account_state_changed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${superAdminId}
        `;
        await expect(
          adminAccess.changeRole({
            action: "GRANT",
            actorSessionIdDigest: superSessionDigest,
            actorUserId: superAdminId,
            eventId: randomUUID(),
            reason: "Suspended actor role grant denied",
            reauthenticationMaxAgeMs: 5 * 60_000,
            role: "ADMIN",
            targetUserId: targetId,
          }),
        ).resolves.toBeUndefined();

        await expect(
          sql`
            INSERT INTO auth_sessions (
              session_id_hash,
              user_id,
              payload,
              expires_at
            ) VALUES (
              ${"not-a-digest"},
              ${registration.user.id},
              ${sql.json({})},
              ${sessionExpiresAt}
            )
          `,
        ).rejects.toThrow();
        await expect(
          sql`
            INSERT INTO auth_sessions (
              session_id_hash,
              user_id,
              payload,
              expires_at
            ) VALUES (
              ${digest(`invalid-payload-${unique}`)},
              ${registration.user.id},
              ${sql.json([])},
              ${sessionExpiresAt}
            )
          `,
        ).rejects.toThrow(/auth_sessions_payload_is_object/);
        await expect(
          sql`
            INSERT INTO password_reset_tokens (
              user_id,
              token_digest,
              expires_at,
              consumed_at,
              invalidated_at
            ) VALUES (
              ${registration.user.id},
              ${digest(`terminal-state-${unique}`)},
              ${sessionExpiresAt},
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
          `,
        ).rejects.toThrow(/password_reset_tokens_one_terminal_state/);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 300_000);
  },
);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function privateMediaKey(
  uuid: string,
): CreateProcessingMediaAssetInput["storageObject"]["key"] {
  return `private/2026/09/${uuid}` as CreateProcessingMediaAssetInput["storageObject"]["key"];
}
