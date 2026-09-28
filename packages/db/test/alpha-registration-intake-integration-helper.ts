import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAlphaRegistrationIntakeRepository } from "../src/alpha-registration-intake-repository.js";

export async function runAlphaRegistrationIntakeIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const repository = createAlphaRegistrationIntakeRepository(sql);
  await expect(repository.readStatus()).resolves.toMatchObject({
    revision: 1,
    state: "PAUSED",
  });

  const actorUserId = randomUUID();
  await sql`INSERT INTO users (id) VALUES (${actorUserId})`;
  const openCommandId = randomUUID();
  const open = {
    actorUserId,
    commandId: openCommandId,
    reason: "Open the bounded synthetic invitation cohort.",
    state: "OPEN" as const,
  };
  await expect(repository.setState(open)).resolves.toEqual({
    status: "APPLIED",
  });
  await expect(repository.setState(open)).resolves.toEqual({
    status: "DEDUPLICATED",
  });

  const firstDigest = "a".repeat(64);
  const issueCommandId = randomUUID();
  const issue = {
    actorUserId,
    cohortCode: "ALPHA_TEST_1",
    commandId: issueCommandId,
    emailHmacDigest: firstDigest,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const issued = await repository.issue(issue);
  expect(issued).toMatchObject({ status: "APPLIED" });
  await expect(repository.issue(issue)).resolves.toMatchObject({
    invitationId:
      "invitationId" in issued ? issued.invitationId : "missing-invitation",
    status: "DEDUPLICATED",
  });

  const normalizedEmail = `alpha-intake-${randomUUID()}@example.invalid`;
  const registered = await repository.registerInvitedUser({
    adultAttested: true,
    emailHmacDigest: firstDigest,
    normalizedEmail,
    passwordHash: "opaque-password-hash",
  });
  expect(registered).toMatchObject({ status: "CREATED" });
  await expect(
    repository.registerInvitedUser({
      adultAttested: true,
      emailHmacDigest: firstDigest,
      normalizedEmail,
      passwordHash: "opaque-password-hash",
    }),
  ).resolves.toEqual({ status: "NOT_AVAILABLE" });

  const raceDigest = "d".repeat(64);
  const raceInvitation = await repository.issue({
    actorUserId,
    cohortCode: "ALPHA_TEST_1",
    commandId: randomUUID(),
    emailHmacDigest: raceDigest,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!("invitationId" in raceInvitation))
    throw new Error("Concurrent invitation missing.");
  const concurrentRegistration = {
    adultAttested: true as const,
    emailHmacDigest: raceDigest,
    normalizedEmail: `alpha-race-${randomUUID()}@example.invalid`,
    passwordHash: "opaque-password-hash",
  };
  const raceResults = await Promise.all([
    repository.registerInvitedUser(concurrentRegistration),
    repository.registerInvitedUser(concurrentRegistration),
  ]);
  expect(raceResults.map(({ status }) => status).sort()).toEqual([
    "CREATED",
    "NOT_AVAILABLE",
  ]);
  const [raceClaim] = await sql<Array<{ readonly claims: number }>>`
    SELECT count(*)::integer AS claims
    FROM alpha_registration_invitation_claims
    WHERE invitation_id = ${raceInvitation.invitationId}
  `;
  expect(raceClaim?.claims).toBe(1);

  const revokedDigest = "b".repeat(64);
  const revocable = await repository.issue({
    actorUserId,
    cohortCode: "ALPHA_TEST_1",
    commandId: randomUUID(),
    emailHmacDigest: revokedDigest,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!("invitationId" in revocable))
    throw new Error("Revocable invitation missing.");
  const revoke = {
    actorUserId,
    commandId: randomUUID(),
    invitationId: revocable.invitationId,
    reason: "Remove this synthetic registration invitation.",
  };
  await expect(repository.revoke(revoke)).resolves.toEqual({
    status: "APPLIED",
  });
  await expect(repository.revoke(revoke)).resolves.toEqual({
    status: "DEDUPLICATED",
  });
  await expect(
    repository.registerInvitedUser({
      adultAttested: true,
      emailHmacDigest: revokedDigest,
      normalizedEmail: `revoked-${randomUUID()}@example.invalid`,
      passwordHash: "opaque-password-hash",
    }),
  ).resolves.toEqual({ status: "NOT_AVAILABLE" });

  const duplicateDigest = "c".repeat(64);
  const duplicateInvitation = await repository.issue({
    actorUserId,
    cohortCode: "ALPHA_TEST_1",
    commandId: randomUUID(),
    emailHmacDigest: duplicateDigest,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!("invitationId" in duplicateInvitation))
    throw new Error("Duplicate-email invitation missing.");
  await expect(
    repository.registerInvitedUser({
      adultAttested: true,
      emailHmacDigest: duplicateDigest,
      normalizedEmail,
      passwordHash: "different-opaque-password-hash",
    }),
  ).resolves.toEqual({ status: "DUPLICATE" });
  const [rolledBackClaim] = await sql<Array<{ readonly claimed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM alpha_registration_invitation_claims
      WHERE invitation_id = ${duplicateInvitation.invitationId}
    ) AS claimed
  `;
  expect(rolledBackClaim?.claimed).toBe(false);

  const [privateShape] = await sql<
    Array<{ readonly emailColumns: number; readonly digestColumns: number }>
  >`
    SELECT
      count(*) FILTER (WHERE column_name ILIKE '%email%'
        AND column_name <> 'email_hmac_digest')::integer AS "emailColumns",
      count(*) FILTER (WHERE column_name = 'email_hmac_digest')::integer
        AS "digestColumns"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name LIKE 'alpha_registration_invitation%'
  `;
  expect(privateShape).toEqual({ emailColumns: 0, digestColumns: 1 });

  const pauseCommandId = randomUUID();
  await expect(
    repository.setState({
      actorUserId,
      commandId: pauseCommandId,
      reason: "Pause new registrations while existing accounts continue.",
      state: "PAUSED",
    }),
  ).resolves.toEqual({ status: "APPLIED" });
  await expect(repository.readStatus()).resolves.toMatchObject({
    state: "PAUSED",
  });
  if (registered.status !== "CREATED")
    throw new Error("Registered account missing before pause assertion.");
  const [preserved] = await sql<
    Array<{ readonly claimPreserved: boolean; readonly userPreserved: boolean }>
  >`
    SELECT
      EXISTS (
        SELECT 1 FROM users WHERE id = ${registered.user.id}
      ) AS "userPreserved",
      EXISTS (
        SELECT 1 FROM alpha_registration_invitation_claims
        WHERE invitation_id = ${registered.invitationId}
          AND user_id = ${registered.user.id}
      ) AS "claimPreserved"
  `;
  expect(preserved).toEqual({ claimPreserved: true, userPreserved: true });
  await expect(
    repository.registerInvitedUser({
      adultAttested: true,
      emailHmacDigest: duplicateDigest,
      normalizedEmail: `paused-${randomUUID()}@example.invalid`,
      passwordHash: "opaque-password-hash",
    }),
  ).resolves.toEqual({ status: "NOT_AVAILABLE" });

  await expect(
    sql`UPDATE alpha_registration_invitations
        SET cohort_code = 'MUTATED'
        WHERE invitation_id = ${duplicateInvitation.invitationId}`,
  ).rejects.toThrow(/append-only/iu);
}
