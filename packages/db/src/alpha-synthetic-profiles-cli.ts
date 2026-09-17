import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  MunicipalityCode,
  UserId,
} from "@portal/domain";
import postgres, { type Sql } from "postgres";

import { createCraftsmanProfessionRepository } from "./craftsman-profession-repository.js";
import { createCraftsmanProfileRepository } from "./craftsman-profile-repository.js";
import { createCraftsmanPublicationRepository } from "./craftsman-publication-repository.js";
import { createCraftsmanServiceAreaRepository } from "./craftsman-service-area-repository.js";

const professionCode = "PROF:ALPHA_SYNTHETIC";
const releaseId = "00000000-0000-4000-8000-000000003301";
const municipalityCode = "TEST:MUNICIPALITY_ALPHA" as MunicipalityCode;
const adminId = "00000000-0000-4000-8000-000000000105" as UserId;
const providers = [
  {
    userId: "00000000-0000-4000-8000-000000000102" as UserId,
    email: "synthetic.account.102@portal.invalid",
    profileType: "INDIVIDUAL" as const,
    realFirstName: "Syntetický",
    realLastName: "Remeselník Alfa",
    nickname: "Testovací remeselník Alfa",
    about: "Syntetický profil Alfa na overenie izolácie pozvánok a ponúk.",
  },
  {
    userId: "00000000-0000-4000-8000-000000000103" as UserId,
    email: "synthetic.account.103@portal.invalid",
    profileType: "COMPANY" as const,
    officialCompanyName: "Syntetická dielňa Beta",
    companyRegistrationNumber: null,
    about: "Syntetický profil Beta na overenie izolácie pozvánok a ponúk.",
  },
] as const;

async function main(): Promise<void> {
  if (
    process.env["APP_ENV"] !== "staging" ||
    process.env["ALPHA_SYNTHETIC_FIXTURE"] !== "1"
  ) {
    throw new Error("Synthetic alpha profiles require explicit staging mode.");
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for synthetic alpha profiles.");
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [marker] = await sql<{ environment: string }[]>`
      SELECT COALESCE(current_setting('portal.environment', true), '') AS environment
    `;
    if (marker?.environment !== "staging") {
      throw new Error(
        "Synthetic alpha profiles target is not a staging database.",
      );
    }
    const [taxonomy] = await sql<{ releaseId: string }[]>`
      SELECT release_id AS "releaseId"
      FROM profession_taxonomy_activation_events
      ORDER BY activation_sequence DESC LIMIT 1
    `;
    if (taxonomy?.releaseId !== releaseId) {
      throw new Error(
        "Synthetic alpha profiles require the isolated test taxonomy.",
      );
    }
    const [admin] = await sql<{ factorId: string }[]>`
      SELECT factor.id AS "factorId"
      FROM users actor
      JOIN auth_credentials credentials ON credentials.user_id = actor.id
      JOIN admin_role_grants role_grant ON role_grant.user_id = actor.id
        AND role_grant.role = 'ADMIN' AND role_grant.revoked_at IS NULL
      JOIN admin_mfa_factors factor ON factor.user_id = actor.id
        AND factor.revoked_at IS NULL
      WHERE actor.id = ${adminId}
        AND actor.account_state = 'ACTIVE'
        AND credentials.normalized_email = 'synthetic.account.105@portal.invalid'
        AND factor.credential_reference = 'test-fixture:mfa/105'
      LIMIT 1
    `;
    if (admin === undefined) {
      throw new Error(
        "Synthetic alpha profiles require the seeded test admin.",
      );
    }

    const profileRepository = createCraftsmanProfileRepository(sql);
    const professionRepository = createCraftsmanProfessionRepository(sql);
    const serviceAreas = createCraftsmanServiceAreaRepository(sql);
    const publications = createCraftsmanPublicationRepository(sql);
    let adminSessionDigest: string | null = null;
    const profileIds: string[] = [];

    for (const provider of providers) {
      const [account] = await sql<{ id: string }[]>`
        SELECT actor.id
        FROM users actor
        JOIN auth_credentials credentials ON credentials.user_id = actor.id
        WHERE actor.id = ${provider.userId}
          AND actor.account_state = 'ACTIVE'
          AND credentials.normalized_email = ${provider.email}
          AND credentials.email_verified_at IS NOT NULL
          AND credentials.phone_verified_at IS NOT NULL
      `;
      if (account === undefined) {
        throw new Error("Synthetic alpha provider account is unavailable.");
      }
      const created = await profileRepository.createPrivateDraft({
        ...provider,
        actorUserId: provider.userId,
      });
      if (created.status !== "CREATED" && created.status !== "UNCHANGED") {
        throw new Error(
          "Synthetic alpha profile conflicts with existing data.",
        );
      }
      const profileId = created.profile.id;
      profileIds.push(profileId);

      const [existingProfession] = await sql<
        { id: string; taxonomyReleaseId: string }[]
      >`
        SELECT id, taxonomy_release_id AS "taxonomyReleaseId"
        FROM craftsman_professions
        WHERE craftsman_profile_id = ${profileId}
          AND profession_code = ${professionCode}
          AND state = 'ACTIVE'
      `;
      if (existingProfession === undefined) {
        const assigned = await professionRepository.assign({
          actorUserId: provider.userId,
          commandId: randomUUID(),
          craftsmanProfessionId: randomUUID() as CraftsmanProfessionId,
          craftsmanProfileId: profileId,
          declaredLevel: "BEGINNER",
          professionCode,
          taxonomyReleaseId: releaseId,
        });
        if (assigned.status !== "APPLIED") {
          throw new Error("Synthetic alpha profession assignment failed.");
        }
      } else if (existingProfession.taxonomyReleaseId !== releaseId) {
        throw new Error("Synthetic alpha profession history conflicts.");
      }

      const area = await serviceAreas.findOwned({
        actorUserId: provider.userId,
        craftsmanProfileId: profileId,
      });
      if (area === null) {
        const assigned = await serviceAreas.replaceOwnedDraft({
          actorUserId: provider.userId,
          baseMunicipalityCode: municipalityCode,
          commandId: randomUUID(),
          craftsmanProfileId: profileId,
          expectedRevision: 0,
          extraMunicipalityCodes: [],
          maximumRadiusKm: null,
          normalRadiusKm: 25,
          travelFeePolicy: null,
          travelFeeThresholdKm: null,
        });
        if (assigned.status !== "APPLIED") {
          throw new Error("Synthetic alpha service area assignment failed.");
        }
      } else if (
        area.baseMunicipalityCode !== municipalityCode ||
        area.normalRadiusKm !== 25 ||
        area.maximumRadiusKm !== null
      ) {
        throw new Error("Synthetic alpha service area history conflicts.");
      }

      let publication = await publications.findOwned({
        actorUserId: provider.userId,
        craftsmanProfileId: profileId,
      });
      if (publication === null) {
        throw new Error("Synthetic alpha publication state is unavailable.");
      }
      if (publication.reviewState === "DRAFT") {
        const submitted = await publications.submitForReview({
          actorUserId: provider.userId,
          commandId: randomUUID(),
          craftsmanProfileId: profileId,
          expectedRevision: publication.revision,
        });
        if (submitted.status !== "APPLIED") {
          throw new Error("Synthetic alpha profile review submission failed.");
        }
        publication = submitted.publication;
      }
      if (publication.reviewState === "PENDING") {
        adminSessionDigest ??= await createFixtureAdminSession(
          sql,
          admin.factorId,
        );
        const approved = await publications.approve({
          actorSessionIdDigest: adminSessionDigest,
          actorUserId: adminId,
          commandId: randomUUID(),
          correlationId: randomUUID(),
          craftsmanProfileId: profileId,
          expectedRevision: publication.revision,
          reason:
            "Synthetic staging-only profile approval for R3 isolation tests.",
        });
        if (approved.status !== "APPLIED") {
          throw new Error("Synthetic alpha profile review approval failed.");
        }
        publication = approved.publication;
      }
      if (
        publication.reviewState === "APPROVED" &&
        publication.ownerVisibility === "HIDDEN"
      ) {
        const shown = await publications.setOwnerVisibility({
          actorUserId: provider.userId,
          commandId: randomUUID(),
          craftsmanProfileId: profileId,
          expectedRevision: publication.revision,
          visibility: "PUBLIC",
        });
        if (shown.status !== "APPLIED") {
          throw new Error("Synthetic alpha profile publication failed.");
        }
        publication = shown.publication;
      }
      if (!publication.effectivelyPublic) {
        throw new Error("Synthetic alpha profile is not effectively public.");
      }
    }

    process.stdout.write(
      `${JSON.stringify({ dataClass: "synthetic", profileIds, status: "PUBLIC" })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function createFixtureAdminSession(
  sql: Sql,
  factorId: string,
): Promise<string> {
  // This short-lived fixture simulates a completed MFA session solely in the
  // isolated staging DB; real admin sessions must pass the MFA challenge.
  const digest = createHash("sha256")
    .update(`alpha-profile-fixture:${randomUUID()}`, "utf8")
    .digest("hex");
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
      VALUES (${digest}, ${adminId}, clock_timestamp() + interval '5 minutes')
    `;
    await transaction`
      INSERT INTO admin_privileged_sessions (
        session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at, expires_at
      ) VALUES (
        ${digest}, ${adminId}, ${factorId}, CURRENT_TIMESTAMP,
        clock_timestamp() + interval '5 minutes'
      )
    `;
  });
  return digest;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(
    `${
      message.startsWith("Synthetic alpha profiles") ||
      message.startsWith("Synthetic alpha profile") ||
      message === "DATABASE_URL is required for synthetic alpha profiles."
        ? message
        : "Synthetic alpha profiles failed safely."
    }\n`,
  );
  process.exitCode = 1;
});
