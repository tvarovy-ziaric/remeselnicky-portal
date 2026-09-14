import { createHash, randomUUID } from "node:crypto";

import { createAdminAccessService } from "@portal/admin-auth";
import type {
  CraftsmanAvailabilityBlockId,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  CraftsmanSkillId,
  CredentialClaimId,
  IndicativePricingEntryId,
  MunicipalityCode,
  PortfolioCollaborationId,
  PortfolioProjectPhotoAttachmentId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import {
  asStorageObjectKey,
  type PortfolioPublicationCommandInput,
  type StoredPortfolioPublicDerivative,
} from "@portal/media";
import {
  verifyR1SupplySideMatrix,
  type R1BoundaryProbeResult,
  type R1CommandRaceEvidence,
  type R1OwnerAction,
  type R1OwnerBoundaryActor,
  type R1OwnerSurface,
  type R1PortfolioDeliveryScenario,
  type R1PrivilegedReviewActor,
  type R1PrivilegedReviewSurface,
  type R1PublicProfileScenario,
  type R1SupplySideMatrixAdapter,
  type TestHttpResponse,
} from "@portal/testing";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAdminAccessRepository } from "../src/admin-auth-repository.js";
import { createCraftsmanAvailabilityRepository } from "../src/craftsman-availability-repository.js";
import { createCraftsmanCapabilityRepository } from "../src/craftsman-capability-repository.js";
import { createCraftsmanExperienceRepository } from "../src/craftsman-experience-repository.js";
import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createCraftsmanProfileRepository } from "../src/craftsman-profile-repository.js";
import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";
import {
  createCredentialClaimRepository,
  createCredentialReviewService,
} from "../src/credential-claim-repository.js";
import { createFeaturedProjectRepository } from "../src/featured-project-repository.js";
import { createIndicativePricingRepository } from "../src/indicative-pricing-repository.js";
import { createMediaRepository } from "../src/media-repository.js";
import { createPortfolioCollaborationRepository } from "../src/portfolio-collaboration-repository.js";
import { createPortfolioProjectPhotoRepository } from "../src/portfolio-project-media-repository.js";
import {
  createPortfolioPublicationRepository,
  createPublicPortfolioDeliveryRepository,
} from "../src/portfolio-publication-repository.js";
import { createPortfolioProjectRepository } from "../src/portfolio-project-repository.js";
import { createPublicCraftsmanProfileRepository } from "../src/public-craftsman-profile-repository.js";

interface TaxonomyFixture {
  readonly professionCode: string;
  readonly releaseId: string;
}

interface LocationFixture {
  readonly districtCode: string;
  readonly municipalityCode: MunicipalityCode;
}

interface AdminFixture {
  readonly rawSessionId: string;
  readonly sessionDigest: string;
  readonly userId: UserId;
}

interface MatrixFixture {
  readonly actors: Readonly<Record<R1OwnerBoundaryActor, UserId>>;
  readonly admin: AdminFixture;
  readonly availabilityBlockId: CraftsmanAvailabilityBlockId;
  readonly collaborationId: PortfolioCollaborationId;
  readonly credentialClaimId: CredentialClaimId;
  readonly credentialTypeCode: string;
  readonly forbiddenMarkers: readonly string[];
  readonly location: LocationFixture;
  readonly ownerId: UserId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly portfolioPrivateStorageKey: ReturnType<typeof asStorageObjectKey>;
  readonly professionId: CraftsmanProfessionId;
  readonly profileId: CraftsmanProfileId;
  publicationRevision: number;
  readonly publicResponses: ReadonlyMap<
    R1PublicProfileScenario,
    TestHttpResponse
  >;
  readonly taxonomy: TaxonomyFixture;
}

/**
 * Standalone R1 security assertion. Run after governed taxonomy/location test
 * fixtures and migrations 0000-0028 exist; it never edits the shared runner.
 */
export async function runR1SupplySideIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await createMatrixFixture(sql);
  const portfolioEvidence = await createPortfolioEvidence(sql, fixture);
  const privilegedEvidence = createPrivilegedEvidence();
  const adapter: R1SupplySideMatrixAdapter = {
    forbiddenMarkers: fixture.forbiddenMarkers,
    probeOwnerBoundary: (input) => probeOwnerBoundary(sql, fixture, input),
    probePortfolioDelivery: (scenario) =>
      Promise.resolve(portfolioEvidence.get(scenario) ?? { allowed: false }),
    probePrivilegedReview: (input) =>
      probePrivilegedReview(sql, fixture, privilegedEvidence, input),
    readPublicProfile: (scenario) =>
      Promise.resolve(required(fixture.publicResponses, scenario)),
    runCommandRaces: () => runCommandRaces(sql),
  };
  await expect(verifyR1SupplySideMatrix(adapter)).resolves.toEqual({
    ownerBoundaryProbes: 130,
    portfolioDeliveryProbes: 5,
    privilegedReviewProbes: 10,
    publicProfileProbes: 6,
    raceChecks: 2,
  });
}

async function createMatrixFixture(sql: Sql): Promise<MatrixFixture> {
  const taxonomy = await loadTaxonomy(sql);
  const location = await loadLocation(sql);
  const ownerId = await createUser(sql);
  const foreignId = await createUser(sql);
  const adminRoleOnlyId = await createRoleOnlyUser(sql, "ADMIN");
  const superadminRoleOnlyId = await createRoleOnlyUser(sql, "SUPER_ADMIN");
  const admin = await createMfaAdmin(sql);
  const privateEmail = `r1-019-${randomUUID()}@private.example.test`;
  const privatePhone = `+421${Number.parseInt(randomUUID().slice(0, 8), 16)
    .toString()
    .padStart(9, "0")
    .slice(0, 9)}`;
  const portfolioPrivateStorageKey = asStorageObjectKey(
    `private/2026/09/${randomUUID()}`,
  );
  await sql`
    INSERT INTO auth_credentials (
      user_id, normalized_email, password_hash, normalized_phone,
      phone_verified_at
    ) VALUES (
      ${ownerId}, ${privateEmail}, ${"$argon2id$test$" + "x".repeat(32)},
      ${privatePhone}, CURRENT_TIMESTAMP
    )
  `;
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (
      owner_user_id, profile_type, real_first_name, real_last_name, nickname,
      about, identity_verified_at, identity_verification_reference
    ) VALUES (
      ${ownerId}, 'INDIVIDUAL', 'Ján', 'Bezpečný', 'Majster Ján',
      'Syntetický profil pre autorizačnú a privacy maticu.', CURRENT_TIMESTAMP,
      ${`verification:r1-019/${randomUUID()}`}
    ) RETURNING id
  `;
  const [collaboratorProfile] = await sql<
    { readonly id: CraftsmanProfileId }[]
  >`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${foreignId}, 'COMPANY') RETURNING id
  `;
  if (profile === undefined || collaboratorProfile === undefined) {
    throw new Error("R1 matrix requires craftsman profiles.");
  }
  const profileId = profile.id;
  const professionId = randomUUID() as CraftsmanProfessionId;
  const professions = createCraftsmanProfessionRepository(sql);
  await expect(
    professions.assign({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profileId,
      declaredLevel: "ADVANCED",
      professionCode: taxonomy.professionCode,
      taxonomyReleaseId: taxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const skillId = randomUUID() as CraftsmanSkillId;
  await expect(
    createCraftsmanCapabilityRepository(sql).addSkill({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: profileId,
      craftsmanSkillId: skillId,
      customText: "Bezpečná syntetická zručnosť",
      identityKind: "CUSTOM",
      professionIds: [professionId],
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
      actorUserId: ownerId,
      baseMunicipalityCode: location.municipalityCode,
      commandId: randomUUID(),
      craftsmanProfileId: profileId,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    createIndicativePricingRepository(sql).add({
      actorUserId: ownerId,
      amountCents: 5_000,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profileId,
      entryId: randomUUID() as IndicativePricingEntryId,
      note: null,
      priceMode: "FROM",
      serviceName: "Syntetická montáž",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    createCraftsmanExperienceRepository(sql).replaceOwnedDraft({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: profileId,
      expectedRevision: 0,
      workingSinceYear: 2015,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const availabilityBlockId = randomUUID() as CraftsmanAvailabilityBlockId;
  await expect(
    createCraftsmanAvailabilityRepository(sql).add({
      actorUserId: ownerId,
      availability: "AVAILABLE",
      blockId: availabilityBlockId,
      commandId: randomUUID(),
      craftsmanProfileId: profileId,
      endsAt: new Date("2030-02-01T00:00:00.000Z"),
      startsAt: new Date("2030-01-01T00:00:00.000Z"),
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const credentialTypeCode = `test.r1019-${randomUUID().slice(0, 8)}`;
  await sql`
    INSERT INTO credential_type_policies (
      code, evidence_requirement, source_reference
    ) VALUES (${credentialTypeCode}, 'REQUIRED', ${`test:r1-019/${randomUUID()}`})
  `;
  const credentialClaimId = randomUUID() as CredentialClaimId;
  const credentials = createCredentialClaimRepository(sql);
  await expect(
    credentials.create({
      actorUserId: ownerId,
      claimId: credentialClaimId,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profileId,
      credentialTypeCode,
      expiresOn: "2035-12-31",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const evidencePreparation = await credentials.prepareEvidenceUpload({
    actorUserId: ownerId,
    claimId: credentialClaimId,
    craftsmanProfileId: profileId,
    expectedRevision: 1,
    mediaKind: "DOCUMENT",
  });
  if (evidencePreparation.status !== "READY") {
    throw new Error("R1 matrix credential evidence upload was not authorized.");
  }
  const evidenceRevision = evidencePreparation.provenance.entityRevision;
  if (evidenceRevision === null) {
    throw new Error("R1 matrix credential provenance omitted its revision.");
  }
  const credentialEvidence = await createCredentialEvidence(sql, {
    claimId: credentialClaimId,
    ownerId,
    revision: evidenceRevision,
  });
  await expect(
    credentials.attachEvidence({
      actorUserId: ownerId,
      claimId: credentialClaimId,
      commandId: randomUUID(),
      craftsmanProfileId: profileId,
      expectedRevision: 1,
      mediaAssetId: credentialEvidence.mediaAssetId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const credentialReview = createCredentialReviewService({
    adminAccess: adminService(sql),
    repository: credentials,
  });
  await expect(
    credentialReview.review({
      actorUserId: admin.userId,
      command: {
        claimId: credentialClaimId,
        commandId: randomUUID(),
        decision: "APPROVE",
        expectedRevision: 2,
      },
      privilegedSessionId: admin.rawSessionId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const portfolioProjectId = randomUUID() as PortfolioProjectId;
  await expect(
    createPortfolioProjectRepository(sql).create({
      actorUserId: ownerId,
      commandId: randomUUID(),
      contribution: null,
      craftsmanProfileId: profileId,
      districtCode: location.districtCode,
      durationUnit: null,
      durationValue: null,
      indicativePriceMaxCents: null,
      indicativePriceMinCents: null,
      materialsAndTechnologies: null,
      municipalityCode: location.municipalityCode,
      portfolioProjectId,
      problem: null,
      professionIds: [professionId],
      shortDescription: "Syntetická bezpečnostná realizácia",
      skillIds: [skillId],
      solution: null,
      specializationIds: [],
      title: "R1 bezpečnostná realizácia",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const collaborationId = randomUUID() as PortfolioCollaborationId;
  await expect(
    createPortfolioCollaborationRepository(sql).invite({
      actorUserId: ownerId,
      authorProfileId: profileId,
      collaborationId,
      collaboratorProfileId: collaboratorProfile.id,
      commandId: randomUUID(),
      contribution: "Syntetická spolupráca na montáži",
      portfolioProjectId,
      role: "Spolupracovník",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const publicProfiles = createPublicCraftsmanProfileRepository(sql);
  const publicResponses = new Map<R1PublicProfileScenario, TestHttpResponse>();
  publicResponses.set(
    "DRAFT",
    response(await publicProfiles.findPublic(profileId)),
  );
  const publication = createCraftsmanPublicationRepository(sql);
  await publication.submitForReview({
    actorUserId: ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: profileId,
    expectedRevision: 0,
  });
  await publication.approve({
    actorSessionIdDigest: admin.sessionDigest,
    actorUserId: admin.userId,
    commandId: randomUUID(),
    correlationId: randomUUID(),
    craftsmanProfileId: profileId,
    expectedRevision: 1,
    reason: "R1 supply-side positive profile review.",
  });
  publicResponses.set(
    "OWNER_HIDDEN",
    response(await publicProfiles.findPublic(profileId)),
  );
  await publication.setOwnerVisibility({
    actorUserId: ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: profileId,
    expectedRevision: 2,
    visibility: "PUBLIC",
  });
  publicResponses.set(
    "PUBLIC_APPROVED",
    response(await publicProfiles.findPublic(profileId)),
  );
  await publication.setModeration({
    actorSessionIdDigest: admin.sessionDigest,
    actorUserId: admin.userId,
    commandId: randomUUID(),
    correlationId: randomUUID(),
    craftsmanProfileId: profileId,
    expectedRevision: 3,
    moderationState: "HIDDEN",
    policyVersion: "R1-019.TEST.1",
    reason: "R1 supply-side moderation privacy assertion.",
    reasonCategory: "SECURITY_TEST",
    reasonCode: "R1_MATRIX_HIDE",
  });
  publicResponses.set(
    "MODERATION_HIDDEN",
    response(await publicProfiles.findPublic(profileId)),
  );
  await publication.restoreModeration({
    actorSessionIdDigest: admin.sessionDigest,
    actorUserId: admin.userId,
    commandId: randomUUID(),
    correlationId: randomUUID(),
    craftsmanProfileId: profileId,
    expectedRevision: 4,
    policyVersion: "R1-019.TEST.1",
    reason: "R1 supply-side moderation restore assertion.",
    reasonCategory: "SECURITY_TEST",
    reasonCode: "R1_MATRIX_RESTORE",
  });
  await setAccountState(sql, ownerId, "SUSPENDED");
  publicResponses.set(
    "SUSPENDED",
    response(await publicProfiles.findPublic(profileId)),
  );
  await setAccountState(sql, ownerId, "ACTIVE");
  publicResponses.set(
    "UNKNOWN",
    response(await publicProfiles.findPublic(randomUUID())),
  );

  return {
    actors: {
      ADMIN_ROLE_ONLY: adminRoleOnlyId,
      FOREIGN: foreignId,
      OWNER: ownerId,
      SUPERADMIN_ROLE_ONLY: superadminRoleOnlyId,
      SUSPENDED: ownerId,
    },
    admin,
    availabilityBlockId,
    collaborationId,
    credentialClaimId,
    credentialTypeCode,
    forbiddenMarkers: [
      privateEmail,
      privatePhone,
      "17.123456",
      ...credentialEvidence.privateMarkers,
      portfolioPrivateStorageKey,
      digest("r1-019-private-content-hash"),
      admin.sessionDigest,
    ],
    location,
    ownerId,
    portfolioProjectId,
    portfolioPrivateStorageKey,
    professionId,
    profileId,
    publicationRevision: 5,
    publicResponses,
    taxonomy,
  };
}

async function probeOwnerBoundary(
  sql: Sql,
  fixture: MatrixFixture,
  input: {
    readonly action: R1OwnerAction;
    readonly actor: R1OwnerBoundaryActor;
    readonly surface: R1OwnerSurface;
  },
): Promise<R1BoundaryProbeResult> {
  const actorUserId =
    input.actor === "SUSPENDED"
      ? fixture.ownerId
      : requiredActor(fixture, input.actor);
  if (input.actor === "SUSPENDED") {
    await setAccountState(sql, fixture.ownerId, "SUSPENDED");
    try {
      return input.action === "OWNER_READ"
        ? await probeOwnerRead(sql, fixture, actorUserId, input.surface)
        : await probeOwnerCommand(sql, fixture, actorUserId, input.surface);
    } finally {
      await setAccountState(sql, fixture.ownerId, "ACTIVE");
    }
  }
  return input.action === "OWNER_READ"
    ? probeOwnerRead(sql, fixture, actorUserId, input.surface)
    : probeOwnerCommand(sql, fixture, actorUserId, input.surface);
}

async function probeOwnerRead(
  sql: Sql,
  fixture: MatrixFixture,
  actorUserId: UserId,
  surface: R1OwnerSurface,
): Promise<R1BoundaryProbeResult> {
  const common = { actorUserId, craftsmanProfileId: fixture.profileId };
  let allowed = false;
  switch (surface) {
    case "PROFILE":
      allowed =
        (await createCraftsmanProfileRepository(sql).findOwnedPrivateDraft(
          actorUserId,
          fixture.profileId,
        )) !== null;
      break;
    case "PROFESSIONS":
      allowed =
        (await createCraftsmanProfessionRepository(sql).listOwned(common))
          .length > 0;
      break;
    case "CAPABILITIES":
      allowed =
        (await createCraftsmanCapabilityRepository(sql).listOwned(common))
          .skills.length > 0;
      break;
    case "SERVICE_AREA":
      allowed =
        (await createCraftsmanServiceAreaRepository(sql).findOwned(common)) !==
        null;
      break;
    case "INDICATIVE_PRICING":
      allowed =
        (await createIndicativePricingRepository(sql).listOwned(common))
          .length > 0;
      break;
    case "EXPERIENCE":
      allowed =
        (await createCraftsmanExperienceRepository(sql).findOwned(common)) !==
        null;
      break;
    case "AVAILABILITY":
      allowed =
        (await createCraftsmanAvailabilityRepository(sql).listOwned(common))
          .length > 0;
      break;
    case "CREDENTIAL_CLAIMS":
      allowed =
        (await createCredentialClaimRepository(sql).listOwned(common)).length >
        0;
      break;
    case "PORTFOLIO_PROJECTS":
      allowed =
        (await createPortfolioProjectRepository(sql).listOwned(common)).length >
        0;
      break;
    case "PORTFOLIO_PHOTOS":
      allowed =
        (await createPortfolioProjectPhotoRepository(sql).listOwned({
          ...common,
          portfolioProjectId: fixture.portfolioProjectId,
        })) !== null;
      break;
    case "PORTFOLIO_COLLABORATIONS":
      allowed =
        (
          await createPortfolioCollaborationRepository(sql).listOwnedAsAuthor({
            actorUserId,
            authorProfileId: fixture.profileId,
            portfolioProjectId: fixture.portfolioProjectId,
          })
        ).length > 0;
      break;
    case "FEATURED_PROJECTS":
      allowed =
        (await createFeaturedProjectRepository(sql).listOwned(common)) !== null;
      break;
    case "PUBLICATION_CONTROL":
      allowed =
        (await createCraftsmanPublicationRepository(sql).findOwned(common)) !==
        null;
      break;
  }
  return { allowed, payload: { status: allowed ? "ALLOWED" : "DENIED" } };
}

async function probeOwnerCommand(
  sql: Sql,
  fixture: MatrixFixture,
  actorUserId: UserId,
  surface: R1OwnerSurface,
): Promise<R1BoundaryProbeResult> {
  const commandId = randomUUID();
  let status = "AUTHORIZATION_DENIED";
  switch (surface) {
    case "PROFILE":
      status = (
        await createCraftsmanProfileRepository(sql).replacePrivateDraft({
          about: "Syntetický profil pre autorizačnú a privacy maticu.",
          actorUserId,
          expectedRevision: 1,
          nickname: "Majster Ján",
          profileId: fixture.profileId,
          profileType: "INDIVIDUAL",
          realFirstName: "Ján",
          realLastName: "Bezpečný",
        })
      ).status;
      break;
    case "PROFESSIONS":
      status = (
        await createCraftsmanProfessionRepository(sql).changeDeclaredLevel({
          actorUserId,
          commandId,
          craftsmanProfessionId: fixture.professionId,
          craftsmanProfileId: fixture.profileId,
          declaredLevel: "ADVANCED",
          expectedDeclaredLevelRevision: 1,
        })
      ).status;
      break;
    case "CAPABILITIES":
      status = (
        await createCraftsmanCapabilityRepository(sql).addSkill({
          actorUserId,
          commandId,
          craftsmanProfileId: fixture.profileId,
          craftsmanSkillId: randomUUID() as CraftsmanSkillId,
          customText: "Ďalšia syntetická zručnosť",
          identityKind: "CUSTOM",
          professionIds: [fixture.professionId],
        })
      ).status;
      break;
    case "SERVICE_AREA":
      status = (
        await createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
          actorUserId,
          baseMunicipalityCode: fixture.location.municipalityCode,
          commandId,
          craftsmanProfileId: fixture.profileId,
          expectedRevision: 1,
          extraMunicipalityCodes: [],
          maximumRadiusKm: null,
          normalRadiusKm: 25,
          travelFeePolicy: null,
          travelFeeThresholdKm: null,
        })
      ).status;
      break;
    case "INDICATIVE_PRICING":
      status = (
        await createIndicativePricingRepository(sql).add({
          actorUserId,
          amountCents: 2_500,
          commandId,
          craftsmanProfileId: fixture.profileId,
          entryId: randomUUID() as IndicativePricingEntryId,
          priceMode: "HOURLY",
          serviceName: "Syntetická hodinová práca",
        })
      ).status;
      break;
    case "EXPERIENCE":
      status = (
        await createCraftsmanExperienceRepository(sql).replaceOwnedDraft({
          actorUserId,
          commandId,
          craftsmanProfileId: fixture.profileId,
          expectedRevision: 1,
          workingSinceYear: 2015,
        })
      ).status;
      break;
    case "AVAILABILITY":
      status = (
        await createCraftsmanAvailabilityRepository(sql).replace({
          actorUserId,
          availability: "AVAILABLE",
          blockId: fixture.availabilityBlockId,
          commandId,
          craftsmanProfileId: fixture.profileId,
          endsAt: new Date("2030-02-01T00:00:00.000Z"),
          expectedRevision: 1,
          startsAt: new Date("2030-01-01T00:00:00.000Z"),
        })
      ).status;
      break;
    case "CREDENTIAL_CLAIMS":
      status = (
        await createCredentialClaimRepository(sql).create({
          actorUserId,
          claimId: randomUUID() as CredentialClaimId,
          commandId,
          craftsmanProfessionId: fixture.professionId,
          craftsmanProfileId: fixture.profileId,
          credentialTypeCode: fixture.credentialTypeCode,
          expiresOn: null,
        })
      ).status;
      break;
    case "PORTFOLIO_PROJECTS":
      status = (
        await createPortfolioProjectRepository(sql).create({
          actorUserId,
          commandId,
          contribution: null,
          craftsmanProfileId: fixture.profileId,
          districtCode: null,
          durationUnit: null,
          durationValue: null,
          indicativePriceMaxCents: null,
          indicativePriceMinCents: null,
          materialsAndTechnologies: null,
          municipalityCode: null,
          portfolioProjectId: randomUUID() as PortfolioProjectId,
          problem: null,
          professionIds: [fixture.professionId],
          shortDescription: "Syntetická súkromná realizácia",
          skillIds: [],
          solution: null,
          specializationIds: [],
          title: "Súkromná R1 realizácia",
        })
      ).status;
      break;
    case "PORTFOLIO_PHOTOS":
      status = (
        await createPortfolioProjectPhotoRepository(sql).reorder({
          actorUserId,
          commandId,
          craftsmanProfileId: fixture.profileId,
          expectedRevision: 1,
          orderedAttachmentIds: await activeAttachmentIds(
            sql,
            fixture.portfolioProjectId,
          ),
          portfolioProjectId: fixture.portfolioProjectId,
        })
      ).status;
      break;
    case "PORTFOLIO_COLLABORATIONS":
      status = (
        await createPortfolioCollaborationRepository(sql).editPending({
          actorUserId,
          collaborationId: fixture.collaborationId,
          commandId,
          contribution: "Syntetická spolupráca na montáži",
          expectedRevision: 1,
          portfolioProjectId: fixture.portfolioProjectId,
          role: "Spolupracovník",
        })
      ).status;
      break;
    case "FEATURED_PROJECTS":
      status = (
        await createFeaturedProjectRepository(sql).reorder({
          actorUserId,
          commandId,
          craftsmanProfileId: fixture.profileId,
          expectedRevision: 0,
          orderedPortfolioProjectIds: [],
        })
      ).status;
      break;
    case "PUBLICATION_CONTROL":
      status = (
        await createCraftsmanPublicationRepository(sql).setOwnerVisibility({
          actorUserId,
          commandId,
          craftsmanProfileId: fixture.profileId,
          expectedRevision: fixture.publicationRevision,
          visibility: "PUBLIC",
        })
      ).status;
      break;
  }
  return {
    allowed: !deniedStatus(status),
    payload: { status: deniedStatus(status) ? "DENIED" : "ALLOWED" },
  };
}

function deniedStatus(status: string): boolean {
  return [
    "ADMIN_AUTHORIZATION_REQUIRED",
    "AUTHORIZATION_DENIED",
    "COLLABORATION_UNAVAILABLE",
    "NOT_FOUND",
    "OWNER_NOT_ACTIVE",
    "PROFILE_UNAVAILABLE",
  ].includes(status);
}

function createPrivilegedEvidence(): ReadonlyMap<
  R1PrivilegedReviewSurface,
  boolean
> {
  const evidence = new Map<R1PrivilegedReviewSurface, boolean>();
  // The profile approval and required-evidence credential approval in fixture
  // creation are the exact capability+MFA positive paths.
  evidence.set("PROFILE_REVIEW", true);
  evidence.set("CREDENTIAL_REVIEW", true);
  return evidence;
}

async function probePrivilegedReview(
  sql: Sql,
  fixture: MatrixFixture,
  positive: ReadonlyMap<R1PrivilegedReviewSurface, boolean>,
  input: {
    readonly actor: R1PrivilegedReviewActor;
    readonly surface: R1PrivilegedReviewSurface;
  },
): Promise<R1BoundaryProbeResult> {
  if (input.actor === "MFA_CAPABILITY_ACTOR") {
    return { allowed: positive.get(input.surface) === true };
  }
  if (input.actor === "SUSPENDED") {
    await setAccountState(sql, fixture.admin.userId, "SUSPENDED");
    try {
      return await runPrivilegedReviewAttempt(sql, fixture, input.surface, {
        actorSessionIdDigest: fixture.admin.sessionDigest,
        actorUserId: fixture.admin.userId,
        privilegedSessionId: fixture.admin.rawSessionId,
      });
    } finally {
      await setAccountState(sql, fixture.admin.userId, "ACTIVE");
    }
  }
  const actorUserId = reviewActorId(fixture, input.actor);
  return runPrivilegedReviewAttempt(sql, fixture, input.surface, {
    actorSessionIdDigest: "f".repeat(64),
    actorUserId,
    privilegedSessionId: `missing-${randomUUID()}`,
  });
}

async function runPrivilegedReviewAttempt(
  sql: Sql,
  fixture: MatrixFixture,
  surface: R1PrivilegedReviewSurface,
  authority: {
    readonly actorSessionIdDigest: string;
    readonly actorUserId: UserId;
    readonly privilegedSessionId: string;
  },
): Promise<R1BoundaryProbeResult> {
  let status: string;
  if (surface === "PROFILE_REVIEW") {
    status = (
      await createCraftsmanPublicationRepository(sql).approve({
        actorSessionIdDigest: authority.actorSessionIdDigest,
        actorUserId: authority.actorUserId,
        commandId: randomUUID(),
        correlationId: randomUUID(),
        craftsmanProfileId: fixture.profileId,
        expectedRevision: fixture.publicationRevision,
        reason: "Unauthorized R1 matrix review attempt.",
      })
    ).status;
  } else {
    status = (
      await createCredentialReviewService({
        adminAccess: adminService(sql),
        repository: createCredentialClaimRepository(sql),
      }).review({
        actorUserId: authority.actorUserId,
        command: {
          claimId: fixture.credentialClaimId,
          commandId: randomUUID(),
          decision: "APPROVE",
          expectedRevision: 2,
        },
        privilegedSessionId: authority.privilegedSessionId,
      })
    ).status;
  }
  return { allowed: !deniedStatus(status), payload: { status: "DENIED" } };
}

function reviewActorId(
  fixture: MatrixFixture,
  actor: Exclude<R1PrivilegedReviewActor, "MFA_CAPABILITY_ACTOR">,
): UserId {
  if (actor === "OWNER") return fixture.ownerId;
  return requiredActor(fixture, actor);
}

function requiredActor(
  fixture: MatrixFixture,
  actor: R1OwnerBoundaryActor,
): UserId {
  const actorUserId = fixture.actors[actor];
  if (actorUserId === undefined) {
    throw new Error(`R1 matrix actor fixture is missing: ${actor}.`);
  }
  return actorUserId;
}

async function createCredentialEvidence(
  sql: Sql,
  input: {
    readonly claimId: CredentialClaimId;
    readonly ownerId: UserId;
    readonly revision: number;
  },
): Promise<{
  readonly mediaAssetId: string;
  readonly privateMarkers: readonly string[];
}> {
  const sourceKey = asStorageObjectKey(`private/2026/09/${randomUUID()}`);
  const canonicalKey = asStorageObjectKey(`private/2026/09/${randomUUID()}`);
  const displayFilename = "r1-019-private-credential.pdf";
  const contentHash = digest(`credential-evidence:${randomUUID()}`);
  const media = createMediaRepository(sql);
  const asset = await media.createProcessingAsset({
    byteSize: 128,
    declaredContentType: "application/pdf",
    displayFilename,
    kind: "DOCUMENT",
    ownerUserId: input.ownerId,
    provenanceEntityId: input.claimId,
    provenanceEntityRevision: input.revision,
    provenanceEntityType: "CREDENTIAL",
    purpose: "CREDENTIAL_DOCUMENT",
    storageObject: { area: "private", key: sourceKey },
    uploaderUserId: input.ownerId,
  });
  await expect(
    media.completeDocumentProcessing({
      assetId: asset.id,
      canonical: {
        byteSize: 128,
        contentSha256: contentHash,
        contentType: "application/pdf",
        role: "CANONICAL",
        storageObject: { area: "private", key: canonicalKey },
      },
      pageCount: 1,
      scan: {
        assurance: "ACTIVE",
        contentSha256: contentHash,
        engine: "r1-matrix-scanner",
        engineVersion: "1.0.0",
        scannedAt: new Date(),
        signatureVersion: "20260914.1",
        verdict: "CLEAN",
      },
    }),
  ).resolves.toEqual({ transition: "UPDATED" });
  return {
    mediaAssetId: asset.id,
    privateMarkers: [sourceKey, canonicalKey, contentHash, displayFilename],
  };
}

async function createPortfolioEvidence(
  sql: Sql,
  fixture: MatrixFixture,
): Promise<ReadonlyMap<R1PortfolioDeliveryScenario, R1BoundaryProbeResult>> {
  const photos = createPortfolioProjectPhotoRepository(sql);
  const mediaAssetId = randomUUID();
  const attachmentId = randomUUID() as PortfolioProjectPhotoAttachmentId;
  const privateStorageKey = fixture.portfolioPrivateStorageKey;
  const privateHash = createHash("sha256")
    .update("r1-019-private-content-hash")
    .digest("hex");
  await sql`
    INSERT INTO media_assets (
      id, owner_user_id, uploaded_by_user_id, kind, purpose, status,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision, ready_at,
      status_changed_at, updated_at, canonical_width, canonical_height
    ) VALUES (${mediaAssetId}, ${fixture.ownerId}, ${fixture.ownerId}, 'IMAGE',
      'PORTFOLIO_IMAGE', 'READY', 'image/jpeg', 100, 'PORTFOLIO_PROJECT',
      ${fixture.portfolioProjectId}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 1200, 900)
  `;
  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (${mediaAssetId}, 'CANONICAL', 'private', ${privateStorageKey},
      'image/webp', 80, ${privateHash})
  `;
  await expect(
    photos.attach({
      actorUserId: fixture.ownerId,
      attachmentId,
      commandId: randomUUID(),
      craftsmanProfileId: fixture.profileId,
      expectedRevision: 0,
      mediaAssetId,
      phase: "AFTER",
      portfolioProjectId: fixture.portfolioProjectId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (${mediaAssetId}, 'THUMBNAIL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'image/webp', 80, ${privateHash})
  `;
  const publication = createPortfolioPublicationRepository(sql);
  const firstCommand = portfolioCommand(fixture, 0);
  const prepared = await publication.preparePublish(firstCommand);
  if (prepared.status !== "READY") {
    throw new Error("R1 matrix portfolio publication was not ready.");
  }
  const firstDerivatives = publicDerivatives(prepared.photos);
  await expect(
    publication.finalizePublish({
      command: firstCommand,
      derivatives: firstDerivatives,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const delivery = createPublicPortfolioDeliveryRepository(sql);
  const evidence = new Map<
    R1PortfolioDeliveryScenario,
    R1BoundaryProbeResult
  >();
  evidence.set(
    "EXACT_PUBLIC_INTERSECTION",
    deliveryResult(await delivery.loadPublicPortfolioDerivative(mediaAssetId)),
  );

  const profilePublication = createCraftsmanPublicationRepository(sql);
  await profilePublication.setOwnerVisibility({
    actorUserId: fixture.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 5,
    visibility: "HIDDEN",
  });
  evidence.set(
    "PROFILE_HIDDEN",
    deliveryResult(await delivery.loadPublicPortfolioDerivative(mediaAssetId)),
  );
  await profilePublication.setOwnerVisibility({
    actorUserId: fixture.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 6,
    visibility: "PUBLIC",
  });
  const hidden = await publication.hide(portfolioCommand(fixture, 1));
  if (hidden.status !== "APPLIED") {
    throw new Error("R1 matrix portfolio hide was not applied.");
  }
  evidence.set(
    "PROJECT_HIDDEN",
    deliveryResult(await delivery.loadPublicPortfolioDerivative(mediaAssetId)),
  );
  for (const pending of hidden.pendingRevocations) {
    await publication.markPublicDerivativeRevoked({
      objectId: pending.objectId,
      publicationRevision: pending.publicationRevision,
    });
  }
  const secondCommand = portfolioCommand(fixture, 2);
  const secondPrepared = await publication.preparePublish(secondCommand);
  if (secondPrepared.status !== "READY") {
    throw new Error("R1 matrix portfolio republish was not ready.");
  }
  const secondDerivatives = publicDerivatives(secondPrepared.photos);
  await publication.finalizePublish({
    command: secondCommand,
    derivatives: secondDerivatives,
  });
  evidence.set(
    "SOURCE_MISMATCH",
    deliveryResult(await delivery.loadPublicPortfolioDerivative(randomUUID())),
  );
  await sql`
    UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
    WHERE id = ${secondDerivatives[0]!.publicObjectId}
  `;
  evidence.set(
    "OBJECT_REVOKED",
    deliveryResult(await delivery.loadPublicPortfolioDerivative(mediaAssetId)),
  );
  fixture.publicationRevision = 7;
  return evidence;
}

function deliveryResult(
  value: Awaited<
    ReturnType<
      ReturnType<
        typeof createPublicPortfolioDeliveryRepository
      >["loadPublicPortfolioDerivative"]
    >
  >,
): R1BoundaryProbeResult {
  return {
    allowed:
      value !== null &&
      value.publicationState === "PUBLIC" &&
      value.revokedAt === null,
    payload: {
      publicationState: value?.publicationState ?? "HIDDEN",
      status: value === null ? "UNAVAILABLE" : "AVAILABLE",
    },
  };
}

function portfolioCommand(
  fixture: MatrixFixture,
  expectedPublicationRevision: number,
): PortfolioPublicationCommandInput {
  return {
    actorUserId: fixture.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.profileId,
    expectedPhotoSetRevision: 1,
    expectedProjectRevision: 1,
    expectedPublicationRevision,
    portfolioProjectId: fixture.portfolioProjectId,
  };
}

function publicDerivatives(
  photos: readonly {
    readonly attachmentId: string;
    readonly byteSize: number;
    readonly canonicalHeight: number;
    readonly canonicalWidth: number;
    readonly contentSha256: string;
    readonly displayOrder: number;
    readonly mediaAssetId: string;
    readonly phase: "AFTER" | "BEFORE" | "OTHER" | "PROGRESS";
    readonly sourceObjectId: string;
  }[],
): readonly StoredPortfolioPublicDerivative[] {
  return photos.map((photo) => {
    const publicObjectId = randomUUID();
    return {
      ...photo,
      publicObject: {
        area: "public-derivative" as const,
        key: asStorageObjectKey(`public-derivative/2026/09/${publicObjectId}`),
      },
      publicObjectId,
      publicUrl: new URL(`https://media.example.test/${publicObjectId}`),
    };
  });
}

async function runCommandRaces(sql: Sql): Promise<R1CommandRaceEvidence> {
  const ownerId = await createUser(sql);
  const firstProfile = await createBareProfile(sql, ownerId);
  const experience = createCraftsmanExperienceRepository(sql);
  const commandId = randomUUID();
  const idempotent = await Promise.all([
    experience.replaceOwnedDraft({
      actorUserId: ownerId,
      commandId,
      craftsmanProfileId: firstProfile,
      expectedRevision: 0,
      workingSinceYear: 2010,
    }),
    experience.replaceOwnedDraft({
      actorUserId: ownerId,
      commandId,
      craftsmanProfileId: firstProfile,
      expectedRevision: 0,
      workingSinceYear: 2010,
    }),
  ]);
  const retry = await experience.replaceOwnedDraft({
    actorUserId: ownerId,
    commandId,
    craftsmanProfileId: firstProfile,
    expectedRevision: 0,
    workingSinceYear: 2010,
  });
  const secondOwner = await createUser(sql);
  const secondProfile = await createBareProfile(sql, secondOwner);
  const cas = await Promise.all([
    experience.replaceOwnedDraft({
      actorUserId: secondOwner,
      commandId: randomUUID(),
      craftsmanProfileId: secondProfile,
      expectedRevision: 0,
      workingSinceYear: 2011,
    }),
    experience.replaceOwnedDraft({
      actorUserId: secondOwner,
      commandId: randomUUID(),
      craftsmanProfileId: secondProfile,
      expectedRevision: 0,
      workingSinceYear: 2012,
    }),
  ]);
  const [idempotentCount] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM craftsman_experience_revisions
    WHERE craftsman_profile_id = ${firstProfile}
  `;
  const [casCount] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM craftsman_experience_revisions
    WHERE craftsman_profile_id = ${secondProfile}
  `;
  return {
    cas: {
      effectCount: casCount?.count ?? -1,
      outcomes: cas.map(({ status }) => raceStatus(status)),
    },
    idempotency: {
      effectCount: idempotentCount?.count ?? -1,
      outcomes: idempotent.map(({ status }) => idempotentStatus(status)),
      retryOutcome: idempotentStatus(retry.status),
    },
  };
}

function raceStatus(status: string): "APPLIED" | "STALE_REVISION" | "DENIED" {
  return status === "APPLIED"
    ? "APPLIED"
    : status === "STALE_REVISION"
      ? "STALE_REVISION"
      : "DENIED";
}

function idempotentStatus(
  status: string,
): "APPLIED" | "DEDUPLICATED" | "DENIED" {
  return status === "APPLIED"
    ? "APPLIED"
    : status === "DEDUPLICATED"
      ? "DEDUPLICATED"
      : "DENIED";
}

async function loadTaxonomy(sql: Sql): Promise<TaxonomyFixture> {
  const [row] = await sql<TaxonomyFixture[]>`
    SELECT profession.release_id AS "releaseId",
      profession.profession_code AS "professionCode"
    FROM profession_taxonomy_activation_events activation
    JOIN taxonomy_professions profession ON profession.release_id = activation.release_id
    WHERE profession.state = 'ACTIVE'
    ORDER BY activation.activation_sequence DESC, profession.profession_code
    LIMIT 1
  `;
  if (row === undefined)
    throw new Error("R1 matrix requires taxonomy fixture.");
  return row;
}

async function loadLocation(sql: Sql): Promise<LocationFixture> {
  const [row] = await sql<LocationFixture[]>`
    SELECT municipality.code AS "municipalityCode",
      municipality.district_code AS "districtCode"
    FROM location_municipalities municipality
    JOIN location_districts district ON district.code = municipality.district_code
    WHERE municipality.is_active AND district.is_active
    ORDER BY municipality.code LIMIT 1
  `;
  if (row === undefined)
    throw new Error("R1 matrix requires location fixture.");
  return row;
}

async function createUser(
  sql: Sql,
  state: "ACTIVE" | "SUSPENDED" = "ACTIVE",
): Promise<UserId> {
  const [row] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users (account_state) VALUES (${state}) RETURNING id
  `;
  if (row === undefined) throw new Error("R1 matrix requires user fixture.");
  return row.id;
}

async function createRoleOnlyUser(
  sql: Sql,
  role: "ADMIN" | "SUPER_ADMIN",
): Promise<UserId> {
  const userId = await createUser(sql);
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${userId}, ${role}, 'BOOTSTRAP', 'R1 role-only negative fixture')
  `;
  return userId;
}

async function createMfaAdmin(sql: Sql): Promise<AdminFixture> {
  const userId = await createUser(sql);
  const rawSessionId = `r1-019-${randomUUID()}`;
  const sessionDigest = digest(rawSessionId);
  const [factor] = await sql<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${userId}, 'TOTP', ${`test:r1-019/${randomUUID()}`}) RETURNING id
  `;
  if (factor === undefined) throw new Error("R1 matrix requires MFA fixture.");
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionDigest}, ${userId}, clock_timestamp() + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${userId}, 'ADMIN', 'BOOTSTRAP', 'R1 exact capability fixture')
  `;
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at, expires_at
    ) VALUES (${sessionDigest}, ${userId}, ${factor.id}, CURRENT_TIMESTAMP,
      clock_timestamp() + interval '1 hour')
  `;
  return { rawSessionId, sessionDigest, userId };
}

function adminService(sql: Sql) {
  return createAdminAccessService({
    challengeTtlMs: 60_000,
    mfaProvider: {
      begin: () => Promise.reject(new Error("MFA fixture cannot begin")),
      verify: () => Promise.resolve(false),
    },
    privilegedSessionTtlMs: 3_600_000,
    reauthenticationMaxAgeMs: 900_000,
    repository: createAdminAccessRepository(sql),
  });
}

async function setAccountState(
  sql: Sql,
  userId: UserId,
  state: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await transaction`
      UPDATE users SET account_state = ${state},
        account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${userId}
    `;
  });
}

async function activeAttachmentIds(
  sql: Sql,
  projectId: PortfolioProjectId,
): Promise<readonly PortfolioProjectPhotoAttachmentId[]> {
  const rows = await sql<
    { readonly attachmentId: PortfolioProjectPhotoAttachmentId }[]
  >`
    SELECT item.attachment_id AS "attachmentId"
    FROM portfolio_project_photo_sets photo_set
    JOIN portfolio_photo_revisions revision
      ON revision.portfolio_project_id = photo_set.portfolio_project_id
      AND revision.revision = photo_set.revision
    JOIN portfolio_photo_revision_items item
      ON item.revision_event_id = revision.event_id
    WHERE photo_set.portfolio_project_id = ${projectId} AND item.state = 'ACTIVE'
    ORDER BY item.display_order
  `;
  return rows.map(({ attachmentId }) => attachmentId);
}

async function createBareProfile(
  sql: Sql,
  ownerId: UserId,
): Promise<CraftsmanProfileId> {
  const [row] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${ownerId}, 'INDIVIDUAL') RETURNING id
  `;
  if (row === undefined) throw new Error("R1 matrix requires race profile.");
  return row.id;
}

function response(value: unknown): TestHttpResponse {
  const found = value !== null;
  return {
    body: found ? value : { code: "NOT_FOUND" },
    headers: {
      "cache-control": "no-store",
      "x-robots-tag": found ? "index, follow" : "noindex, nofollow",
    },
    statusCode: found ? 200 : 404,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function required<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key);
  if (value === undefined) throw new Error("R1 matrix evidence is missing.");
  return value;
}
