import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  MunicipalityCode,
  PortfolioCollaborationId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";
import { createPortfolioCollaborationRepository } from "../src/portfolio-collaboration-repository.js";
import { createPortfolioProjectRepository } from "../src/portfolio-project-repository.js";

/** Runs inside the single clean-migration integration test after migration 0026. */
export async function runPortfolioCollaborationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const municipality = await findMunicipality(sql);
  const admin = await createAdmin(sql);
  const author = await createCraftsman(sql, "Anna", municipality, admin);
  const collaborator = await createCraftsman(sql, "Boris", municipality, admin);
  const outsider = await createPrivateCraftsman(sql, "Cyril");

  const projectId = await createProject(sql, author, "Autorská realizácia");
  const reverseProjectId = await createProject(
    sql,
    collaborator,
    "Spolupracovníkova realizácia",
  );
  const repository = createPortfolioCollaborationRepository(sql);
  await exerciseCrossInvites(sql, repository, {
    author,
    collaborator,
    projectId,
    reverseProjectId,
  });
  const collaborationId = randomUUID() as PortfolioCollaborationId;
  const inviteCommandId = randomUUID();
  const invite = {
    actorUserId: author.userId,
    authorProfileId: author.profileId,
    collaboratorProfileId: collaborator.profileId,
    collaborationId,
    commandId: inviteCommandId,
    contribution: "Zapojenie a odborná kontrola rozvádzača.",
    portfolioProjectId: projectId,
    role: "Elektrotechnik",
  } as const;
  const inviteRace = await Promise.all([
    repository.invite(invite),
    repository.invite(invite),
  ]);
  expect(inviteRace.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);

  await expect(
    repository.accept({
      actorUserId: author.userId,
      collaborationId,
      collaboratorProfileId: collaborator.profileId,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: projectId,
    }),
  ).resolves.toEqual({ status: "COLLABORATION_UNAVAILABLE" });
  await expect(
    repository.accept({
      actorUserId: outsider.userId,
      collaborationId,
      collaboratorProfileId: collaborator.profileId,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: projectId,
    }),
  ).resolves.toEqual({ status: "COLLABORATION_UNAVAILABLE" });
  await expect(
    repository.accept({
      actorUserId: collaborator.userId,
      collaborationId,
      collaboratorProfileId: outsider.profileId,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: projectId,
    }),
  ).resolves.toEqual({ status: "COLLABORATION_UNAVAILABLE" });

  const acceptCommandId = randomUUID();
  const accept = {
    actorUserId: collaborator.userId,
    collaborationId,
    collaboratorProfileId: collaborator.profileId,
    commandId: acceptCommandId,
    expectedRevision: 1,
    portfolioProjectId: projectId,
  } as const;
  const accepted = await repository.accept(accept);
  expect(accepted).toMatchObject({
    collaboration: {
      contribution: invite.contribution,
      revision: 2,
      role: invite.role,
      state: "ACCEPTED",
      visibility: "VISIBLE",
    },
    status: "APPLIED",
  });
  await expect(repository.accept(accept)).resolves.toMatchObject({
    collaboration: { revision: 2, state: "ACCEPTED", visibility: "VISIBLE" },
    status: "DEDUPLICATED",
  });
  await expect(publicCandidates(sql, projectId)).resolves.toEqual([
    expect.objectContaining({
      collaboratorProfileId: collaborator.profileId,
      contribution: invite.contribution,
      role: invite.role,
    }),
  ]);

  const hidden = await repository.hide({
    actorUserId: author.userId,
    collaborationId,
    commandId: randomUUID(),
    expectedRevision: 2,
    portfolioProjectId: projectId,
  });
  expect(hidden).toMatchObject({
    collaboration: { revision: 3, state: "ACCEPTED", visibility: "HIDDEN" },
    status: "APPLIED",
  });
  await expect(publicCandidates(sql, projectId)).resolves.toEqual([]);

  // A retry of the older confirmation returns its immutable historical snapshot.
  await expect(repository.accept(accept)).resolves.toMatchObject({
    collaboration: { revision: 2, state: "ACCEPTED", visibility: "VISIBLE" },
    status: "DEDUPLICATED",
  });
  const shown = await repository.show({
    actorUserId: author.userId,
    collaborationId,
    commandId: randomUUID(),
    expectedRevision: 3,
    portfolioProjectId: projectId,
  });
  expect(shown).toMatchObject({
    collaboration: { revision: 4, state: "ACCEPTED", visibility: "VISIBLE" },
    status: "APPLIED",
  });
  await expect(publicCandidates(sql, projectId)).resolves.toHaveLength(1);

  await runRawSqlBoundaryAssertions(sql, {
    authorUserId: author.userId,
    collaborationId,
    projectId,
  });

  const race = await Promise.all([
    repository.hide({
      actorUserId: author.userId,
      collaborationId,
      commandId: randomUUID(),
      expectedRevision: 4,
      portfolioProjectId: projectId,
    }),
    repository.withdrawAccepted({
      actorUserId: collaborator.userId,
      collaborationId,
      collaboratorProfileId: collaborator.profileId,
      commandId: randomUUID(),
      expectedRevision: 4,
      portfolioProjectId: projectId,
    }),
  ]);
  expect(race.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  await expect(publicCandidates(sql, projectId)).resolves.toEqual([]);
  const [history] = await sql<
    { readonly acceptedSnapshots: number; readonly revisionCount: number }[]
  >`
    SELECT count(*)::integer AS "revisionCount",
      count(*) FILTER (WHERE accepted_at IS NOT NULL)::integer
        AS "acceptedSnapshots"
    FROM portfolio_collaboration_revisions
    WHERE collaboration_id = ${collaborationId}
  `;
  expect(history).toEqual({ acceptedSnapshots: 4, revisionCount: 5 });

  await exerciseTerminalInvitations(sql, repository, {
    author,
    outsider,
    projectId,
  });

  await sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM users WHERE id = ${collaborator.userId} FOR UPDATE
    `;
    await transaction`
      UPDATE users SET account_state = 'SUSPENDED',
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = ${collaborator.userId}
    `;
  });
  await expect(repository.accept(accept)).resolves.toEqual({
    status: "COLLABORATION_UNAVAILABLE",
  });
}

async function exerciseCrossInvites(
  sql: Sql,
  repository: ReturnType<typeof createPortfolioCollaborationRepository>,
  fixture: {
    readonly author: CraftsmanFixture;
    readonly collaborator: CraftsmanFixture;
    readonly projectId: PortfolioProjectId;
    readonly reverseProjectId: PortfolioProjectId;
  },
): Promise<void> {
  const forwardId = randomUUID() as PortfolioCollaborationId;
  const reverseId = randomUUID() as PortfolioCollaborationId;
  const results = await Promise.all([
    repository.invite({
      actorUserId: fixture.author.userId,
      authorProfileId: fixture.author.profileId,
      collaboratorProfileId: fixture.collaborator.profileId,
      collaborationId: forwardId,
      commandId: randomUUID(),
      contribution: "Odborná pomoc na spoločnej realizácii.",
      portfolioProjectId: fixture.projectId,
      role: "Spolupracovník",
    }),
    repository.invite({
      actorUserId: fixture.collaborator.userId,
      authorProfileId: fixture.collaborator.profileId,
      collaboratorProfileId: fixture.author.profileId,
      collaborationId: reverseId,
      commandId: randomUUID(),
      contribution: "Odborná pomoc na opačnej realizácii.",
      portfolioProjectId: fixture.reverseProjectId,
      role: "Spolupracovník",
    }),
  ]);
  expect(results.map(({ status }) => status)).toEqual(["APPLIED", "APPLIED"]);
  await expect(
    repository.decline({
      actorUserId: fixture.collaborator.userId,
      collaborationId: forwardId,
      collaboratorProfileId: fixture.collaborator.profileId,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: fixture.projectId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.decline({
      actorUserId: fixture.author.userId,
      collaborationId: reverseId,
      collaboratorProfileId: fixture.author.profileId,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: fixture.reverseProjectId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const [history] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM portfolio_collaboration_revisions
    WHERE collaboration_id IN (${forwardId}, ${reverseId})
  `;
  expect(history?.count).toBe(4);
}

async function exerciseTerminalInvitations(
  sql: Sql,
  repository: ReturnType<typeof createPortfolioCollaborationRepository>,
  fixture: {
    readonly author: CraftsmanFixture;
    readonly outsider: PrivateCraftsmanFixture;
    readonly projectId: PortfolioProjectId;
  },
): Promise<void> {
  const declinedId = randomUUID() as PortfolioCollaborationId;
  await expect(
    repository.invite({
      actorUserId: fixture.author.userId,
      authorProfileId: fixture.author.profileId,
      collaboratorProfileId: fixture.outsider.profileId,
      collaborationId: declinedId,
      commandId: randomUUID(),
      contribution: "Pomoc pri montáži bezpečných rozvodov.",
      portfolioProjectId: fixture.projectId,
      role: "Montážnik",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const declined = await repository.decline({
    actorUserId: fixture.outsider.userId,
    collaborationId: declinedId,
    collaboratorProfileId: fixture.outsider.profileId,
    commandId: randomUUID(),
    expectedRevision: 1,
    portfolioProjectId: fixture.projectId,
  });
  expect(declined).toMatchObject({
    collaboration: { revision: 2, state: "DECLINED" },
    status: "APPLIED",
  });

  const withdrawnId = randomUUID() as PortfolioCollaborationId;
  await expect(
    repository.invite({
      actorUserId: fixture.author.userId,
      authorProfileId: fixture.author.profileId,
      collaboratorProfileId: fixture.outsider.profileId,
      collaborationId: withdrawnId,
      commandId: randomUUID(),
      contribution: "Pomoc pri príprave bezpečného pracoviska.",
      portfolioProjectId: fixture.projectId,
      role: "Pomocník",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.withdrawPending({
      actorUserId: fixture.author.userId,
      collaborationId: withdrawnId,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: fixture.projectId,
    }),
  ).resolves.toMatchObject({
    collaboration: { revision: 2, state: "AUTHOR_WITHDRAWN" },
    status: "APPLIED",
  });

  const [terminalRows] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM portfolio_collaboration_revisions
    WHERE collaboration_id IN (${declinedId}, ${withdrawnId})
  `;
  expect(terminalRows?.count).toBe(4);
}

async function runRawSqlBoundaryAssertions(
  sql: Sql,
  fixture: {
    readonly authorUserId: UserId;
    readonly collaborationId: PortfolioCollaborationId;
    readonly projectId: PortfolioProjectId;
  },
): Promise<void> {
  await expect(sql`
    UPDATE portfolio_collaborations SET role = 'Podvrhnutá rola'
    WHERE id = ${fixture.collaborationId}
  `).rejects.toThrow(/exact command provenance/u);
  await expect(sql`
    DELETE FROM portfolio_collaborations WHERE id = ${fixture.collaborationId}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    UPDATE portfolio_collaboration_revisions SET contribution = 'Podvrhnuté'
    WHERE collaboration_id = ${fixture.collaborationId}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    DELETE FROM portfolio_collaboration_commands
    WHERE collaboration_id = ${fixture.collaborationId}
  `).rejects.toThrow(/append-only/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_collaboration_commands (
          command_id, command_kind, collaboration_id, portfolio_project_id,
          actor_kind, actor_user_id, expected_revision, resulting_revision,
          payload_fingerprint
        ) VALUES (
          ${randomUUID()}, 'HIDE', ${fixture.collaborationId},
          ${fixture.projectId}, 'AUTHOR', ${fixture.authorUserId}, 4, 5,
          ${"a".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/exact head and revision effects/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_collaboration_commands (
          command_id, command_kind, collaboration_id, portfolio_project_id,
          actor_kind, actor_user_id, expected_revision, resulting_revision,
          payload_fingerprint
        ) VALUES (
          ${randomUUID()}, 'COLLABORATOR_ACCEPT', ${fixture.collaborationId},
          ${fixture.projectId}, 'AUTHOR', ${fixture.authorUserId}, 4, 5,
          ${"b".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/actor_shape|violates check constraint/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_collaboration_commands (
          command_id, command_kind, collaboration_id, portfolio_project_id,
          actor_kind, actor_user_id, expected_revision, resulting_revision,
          requested_role, payload_fingerprint
        ) VALUES (
          ${randomUUID()}, 'HIDE', ${fixture.collaborationId},
          ${fixture.projectId}, 'AUTHOR', ${fixture.authorUserId}, 4, 5,
          'Irrelevant spoofed role', ${"c".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/content_shape|violates check constraint/u);
  await expect(sql`
    INSERT INTO portfolio_collaboration_revisions (
      command_id, collaboration_id, revision, state, visibility,
      role, contribution, actor_user_id
    ) VALUES (
      ${randomUUID()}, ${fixture.collaborationId}, 999, 'ACCEPTED', 'VISIBLE',
      'Podvrhnutá rola', 'Podvrhnutý príspevok', ${fixture.authorUserId}
    )
  `).rejects.toThrow(/exact command snapshot|foreign key/u);
}

interface AdminFixture {
  readonly sessionDigest: string;
  readonly userId: UserId;
}

interface PrivateCraftsmanFixture {
  readonly profileId: CraftsmanProfileId;
  readonly userId: UserId;
}

interface CraftsmanFixture extends PrivateCraftsmanFixture {
  readonly professionId: CraftsmanProfessionId;
}

async function createProject(
  sql: Sql,
  owner: CraftsmanFixture,
  title: string,
): Promise<PortfolioProjectId> {
  const portfolioProjectId = randomUUID() as PortfolioProjectId;
  await expect(
    createPortfolioProjectRepository(sql).create({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      contribution: "Návrh a vykonanie bezpečnej elektroinštalácie",
      craftsmanProfileId: owner.profileId,
      districtCode: null,
      durationUnit: null,
      durationValue: null,
      indicativePriceMaxCents: null,
      indicativePriceMinCents: null,
      materialsAndTechnologies: null,
      municipalityCode: null,
      portfolioProjectId,
      problem: null,
      professionIds: [owner.professionId],
      shortDescription: "Bezpečný opis spoločnej realizácie mimo platformy",
      skillIds: [],
      solution: null,
      specializationIds: [],
      title,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  return portfolioProjectId;
}

async function createCraftsman(
  sql: Sql,
  firstName: string,
  municipality: MunicipalityCode,
  admin: AdminFixture,
): Promise<CraftsmanFixture> {
  const privateFixture = await createPrivateCraftsman(sql, firstName);
  const professionId = await assignProfession(sql, privateFixture);
  await expect(
    createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
      actorUserId: privateFixture.userId,
      baseMunicipalityCode: municipality,
      commandId: randomUUID(),
      craftsmanProfileId: privateFixture.profileId,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const publications = createCraftsmanPublicationRepository(sql);
  await expect(
    publications.submitForReview({
      actorUserId: privateFixture.userId,
      commandId: randomUUID(),
      craftsmanProfileId: privateFixture.profileId,
      expectedRevision: 0,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    publications.setOwnerVisibility({
      actorUserId: privateFixture.userId,
      commandId: randomUUID(),
      craftsmanProfileId: privateFixture.profileId,
      expectedRevision: 1,
      visibility: "PUBLIC",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    publications.approve({
      actorSessionIdDigest: admin.sessionDigest,
      actorUserId: admin.userId,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      craftsmanProfileId: privateFixture.profileId,
      expectedRevision: 2,
      reason: "Explicit collaborator integration approval.",
    }),
  ).resolves.toMatchObject({
    publication: { effectivelyPublic: true },
    status: "APPLIED",
  });
  return { ...privateFixture, professionId };
}

async function createPrivateCraftsman(
  sql: Sql,
  firstName: string,
): Promise<PrivateCraftsmanFixture> {
  const [user] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (user === undefined) throw new Error("Expected collaborator test user.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (
      owner_user_id, profile_type, real_first_name, real_last_name, about
    ) VALUES (
      ${user.id}, 'INDIVIDUAL', ${firstName}, 'Testovací',
      'Spoľahlivý testovací remeselník pre integračné overenie.'
    ) RETURNING id
  `;
  if (profile === undefined)
    throw new Error("Expected collaborator test profile.");
  return { profileId: profile.id, userId: user.id };
}

async function assignProfession(
  sql: Sql,
  fixture: PrivateCraftsmanFixture,
): Promise<CraftsmanProfessionId> {
  const [candidate] = await sql<
    { readonly professionCode: string; readonly releaseId: string }[]
  >`
    SELECT profession.profession_code AS "professionCode",
      profession.release_id AS "releaseId"
    FROM profession_taxonomy_activation_events activation
    JOIN taxonomy_professions profession
      ON profession.release_id = activation.release_id
    WHERE profession.state = 'ACTIVE'
    ORDER BY activation.activation_sequence DESC, profession.profession_code
    LIMIT 1
  `;
  if (candidate === undefined)
    throw new Error("Expected active profession taxonomy fixture.");
  const professionId = randomUUID() as CraftsmanProfessionId;
  await expect(
    createCraftsmanProfessionRepository(sql).assign({
      actorUserId: fixture.userId,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: fixture.profileId,
      declaredLevel: "ADVANCED",
      professionCode: candidate.professionCode,
      taxonomyReleaseId: candidate.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  return professionId;
}

async function findMunicipality(sql: Sql): Promise<MunicipalityCode> {
  const [row] = await sql<{ readonly code: MunicipalityCode }[]>`
    SELECT municipality.code
    FROM location_municipalities municipality
    JOIN location_districts district
      ON district.code = municipality.district_code
    JOIN location_regions region ON region.code = district.region_code
    WHERE municipality.is_active AND district.is_active AND region.is_active
    ORDER BY municipality.code LIMIT 1
  `;
  if (row === undefined)
    throw new Error("Expected synthetic governed municipality fixture.");
  return row.code;
}

async function createAdmin(sql: Sql): Promise<AdminFixture> {
  const [user] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (user === undefined) throw new Error("Expected collaboration test admin.");
  const sessionDigest = createHash("sha256").update(randomUUID()).digest("hex");
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionDigest}, ${user.id}, CURRENT_TIMESTAMP + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${user.id}, 'ADMIN', 'BOOTSTRAP', 'R1-016 integration admin')
  `;
  const [factor] = await sql<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${user.id}, 'TOTP', ${`test:r1016/${randomUUID()}`})
    RETURNING id
  `;
  if (factor === undefined)
    throw new Error("Expected collaboration MFA factor.");
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at,
      created_at, expires_at
    ) VALUES (
      ${sessionDigest}, ${user.id}, ${factor.id}, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour'
    )
  `;
  return { sessionDigest, userId: user.id };
}

async function publicCandidates(sql: Sql, projectId: PortfolioProjectId) {
  return sql<
    {
      readonly collaboratorProfileId: CraftsmanProfileId;
      readonly contribution: string;
      readonly role: string;
    }[]
  >`
    SELECT collaborator_profile_id AS "collaboratorProfileId", role,
      contribution
    FROM current_portfolio_collaboration_candidates
    WHERE project_id = ${projectId}
  `;
}
