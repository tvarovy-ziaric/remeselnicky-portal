import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfileService, type UserId } from "@portal/domain";

import { createCraftsmanProfileRepository } from "../src/index.js";

export async function runCraftsmanProfileIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const repository = createCraftsmanProfileRepository(sql);
  const service = createCraftsmanProfileService(repository);
  const [combinedOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES
    RETURNING id
  `;
  if (combinedOwner === undefined) {
    throw new Error("Expected an integration craftsman owner.");
  }
  await sql`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${combinedOwner.id})
  `;

  const concurrentCreates = await Promise.all([
    service.createPrivateDraft({
      actorUserId: combinedOwner.id,
      profileType: "INDIVIDUAL",
    }),
    service.createPrivateDraft({
      actorUserId: combinedOwner.id,
      profileType: "INDIVIDUAL",
    }),
  ]);
  expect(concurrentCreates.map(({ status }) => status).sort()).toEqual([
    "CREATED",
    "UNCHANGED",
  ]);
  const created = concurrentCreates.find(
    (result) => result.status === "CREATED",
  );
  if (created === undefined || !("profile" in created)) {
    throw new Error("Expected the created craftsman draft.");
  }
  const profileId = created.profile.id;

  const [capabilities] = await sql<
    { readonly craftsmanCount: number; readonly customerCount: number }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM craftsman_profiles
        WHERE owner_user_id = ${combinedOwner.id}) AS "craftsmanCount",
      (SELECT count(*)::integer FROM customer_profiles
        WHERE owner_user_id = ${combinedOwner.id}) AS "customerCount"
  `;
  expect(capabilities).toEqual({ craftsmanCount: 1, customerCount: 1 });
  await expect(
    service.createPrivateDraft({
      actorUserId: combinedOwner.id,
      profileType: "COMPANY",
    }),
  ).resolves.toEqual({ status: "ALREADY_EXISTS" });

  const [suspendedOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users (account_state)
    VALUES ('SUSPENDED')
    RETURNING id
  `;
  if (suspendedOwner === undefined) {
    throw new Error("Expected a suspended integration owner.");
  }
  await expect(
    service.createPrivateDraft({
      actorUserId: suspendedOwner.id,
      profileType: "COMPANY",
    }),
  ).resolves.toEqual({ status: "OWNER_NOT_ACTIVE" });
  await expect(
    service.createPrivateDraft({
      actorUserId: randomUUID() as UserId,
      profileType: "INDIVIDUAL",
    }),
  ).resolves.toEqual({ status: "OWNER_NOT_ACTIVE" });
  await expect(sql`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${suspendedOwner.id}, 'COMPANY')
  `).rejects.toThrow(/owner must be ACTIVE/u);

  const [activeOther] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES
    RETURNING id
  `;
  if (activeOther === undefined) {
    throw new Error("Expected a second active integration owner.");
  }
  await expect(sql`
    INSERT INTO craftsman_profiles (
      owner_user_id,
      profile_type,
      real_first_name,
      real_last_name,
      official_company_name
    ) VALUES (
      ${activeOther.id},
      'INDIVIDUAL',
      'Ján',
      'Remeselník',
      'Forbidden company identity'
    )
  `).rejects.toThrow(/craftsman_profiles_fields_match_type/u);

  await sql`
    UPDATE craftsman_profiles
    SET
      real_first_name = 'Ján',
      real_last_name = 'Remeselník'
    WHERE id = ${profileId}
  `;
  await sql`
    UPDATE craftsman_profiles
    SET
      identity_verified_at = CURRENT_TIMESTAMP,
      identity_verification_reference = 'verification:test/identity'
    WHERE id = ${profileId}
  `;
  const [verifiedDraft] = await sql<
    {
      readonly identityVerifiedAt: Date;
      readonly revision: number;
    }[]
  >`
    SELECT
      identity_verified_at AS "identityVerifiedAt",
      revision
    FROM craftsman_profiles
    WHERE id = ${profileId}
  `;
  expect(verifiedDraft?.identityVerifiedAt).toBeInstanceOf(Date);
  if (verifiedDraft === undefined) {
    throw new Error("Expected a verified integration draft.");
  }
  await expect(sql`
    UPDATE craftsman_profiles
    SET real_last_name = 'Pokus o ponechanie starej verifikácie'
    WHERE id = ${profileId}
  `).rejects.toThrow(/changed identity must clear prior verification/u);

  const preserved = await service.replacePrivateDraft({
    about: "Profil bez zverejnenia\r\nS druhým riadkom",
    actorUserId: combinedOwner.id,
    expectedRevision: verifiedDraft.revision,
    nickname: "Majster Jano",
    profileId,
    profileType: "INDIVIDUAL",
    realFirstName: "Ján",
    realLastName: "Remeselník",
  });
  expect(preserved.status).toBe("UPDATED");
  if (!("profile" in preserved)) {
    throw new Error("Expected an updated integration draft.");
  }
  expect(preserved.profile.identityVerification).not.toBeNull();
  expect(preserved.profile.about).toBe(
    "Profil bez zverejnenia\nS druhým riadkom",
  );
  await expect(sql`
    UPDATE craftsman_profiles
    SET about = ${"Opis\tso zakázaným tabulátorom"}
    WHERE id = ${profileId}
  `).rejects.toThrow(/craftsman_profiles_about_safe/u);
  const identityChanged = await service.replacePrivateDraft({
    about: preserved.profile.about,
    actorUserId: combinedOwner.id,
    expectedRevision: preserved.profile.revision,
    nickname:
      preserved.profile.profileType === "INDIVIDUAL"
        ? preserved.profile.nickname
        : null,
    profileId,
    profileType: "INDIVIDUAL",
    realFirstName: "Ján",
    realLastName: "Nové priezvisko",
  });
  expect(identityChanged).toMatchObject({
    profile: { identityVerification: null },
    status: "UPDATED",
  });
  if (!("profile" in identityChanged)) {
    throw new Error("Expected an identity-changed integration draft.");
  }

  const competingWrites = await Promise.all([
    service.replacePrivateDraft({
      about: "Prvý paralelný obsah",
      actorUserId: combinedOwner.id,
      expectedRevision: identityChanged.profile.revision,
      nickname: null,
      profileId,
      profileType: "INDIVIDUAL",
      realFirstName: "Ján",
      realLastName: "Nové priezvisko",
    }),
    service.replacePrivateDraft({
      about: "Druhý paralelný obsah",
      actorUserId: combinedOwner.id,
      expectedRevision: identityChanged.profile.revision,
      nickname: null,
      profileId,
      profileType: "INDIVIDUAL",
      realFirstName: "Ján",
      realLastName: "Nové priezvisko",
    }),
  ]);
  expect(
    competingWrites.filter(({ status }) => status === "UPDATED"),
  ).toHaveLength(1);
  expect(
    competingWrites.filter(({ status }) => status === "STALE_REVISION"),
  ).toHaveLength(1);

  const winner = competingWrites.find(({ status }) => status === "UPDATED");
  if (winner === undefined || !("profile" in winner)) {
    throw new Error("Expected one winning compare-and-set update.");
  }
  const retry = await service.replacePrivateDraft({
    about: winner.profile.about,
    actorUserId: combinedOwner.id,
    expectedRevision: identityChanged.profile.revision,
    nickname:
      winner.profile.profileType === "INDIVIDUAL"
        ? winner.profile.nickname
        : null,
    profileId,
    profileType: "INDIVIDUAL",
    realFirstName: "Ján",
    realLastName: "Nové priezvisko",
  });
  expect(retry).toMatchObject({ status: "UNCHANGED" });

  await expect(
    service.replacePrivateDraft({
      about: null,
      actorUserId: activeOther.id,
      expectedRevision: 1,
      nickname: null,
      profileId,
      profileType: "INDIVIDUAL",
      realFirstName: null,
      realLastName: null,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await expect(sql`
    UPDATE craftsman_profiles
    SET owner_user_id = ${activeOther.id}
    WHERE id = ${profileId}
  `).rejects.toThrow(/ownership cannot be reassigned/u);
  await expect(sql`
    DELETE FROM craftsman_profiles
    WHERE id = ${profileId}
  `).rejects.toThrow(/history cannot be hard-deleted/u);
  await sql`
    UPDATE users
    SET
      account_state = 'SUSPENDED',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${combinedOwner.id}
  `;
  await expect(sql`
    UPDATE craftsman_profiles
    SET about = 'Zakázaná úprava pozastaveného vlastníka'
    WHERE id = ${profileId}
  `).rejects.toThrow(/owner must be ACTIVE/u);

  await runSuspensionEditRace(sql);

  const directOwnerId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${directOwnerId})`;
  const futureTimestamp = new Date("2999-01-01T00:00:00.000Z");
  const [serverAuthored] = await sql<
    {
      readonly createdAt: Date;
      readonly identityVerifiedAt: Date | null;
      readonly revision: number;
      readonly updatedAt: Date;
    }[]
  >`
    INSERT INTO craftsman_profiles (
      owner_user_id,
      profile_type,
      identity_verified_at,
      identity_verification_reference,
      revision,
      created_at,
      updated_at
    ) VALUES (
      ${directOwnerId},
      'COMPANY',
      ${futureTimestamp},
      'verification:test/spoof',
      99,
      ${futureTimestamp},
      ${futureTimestamp}
    )
    RETURNING
      created_at AS "createdAt",
      identity_verified_at AS "identityVerifiedAt",
      revision,
      updated_at AS "updatedAt"
  `;
  expect(serverAuthored).toMatchObject({
    identityVerifiedAt: null,
    revision: 1,
  });
  expect(serverAuthored?.createdAt.getUTCFullYear()).toBeLessThan(2999);
  expect(serverAuthored?.updatedAt).toEqual(serverAuthored?.createdAt);
}

async function runSuspensionEditRace(sql: Sql): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES
    RETURNING id
  `;
  if (owner === undefined) {
    throw new Error("Expected a race-test owner.");
  }
  const [profile] = await sql<{ readonly id: string }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (profile === undefined) {
    throw new Error("Expected a race-test profile.");
  }

  const [suspensionResult, editResult] = await Promise.allSettled([
    sql.begin(
      (transaction) => transaction`
      UPDATE users
      SET
        account_state = 'SUSPENDED',
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = ${owner.id}
    `,
    ),
    sql.begin(
      (transaction) => transaction`
      UPDATE craftsman_profiles
      SET about = 'Race-safe edit'
      WHERE id = ${profile.id}
    `,
    ),
  ]);
  expect(suspensionResult.status).toBe("fulfilled");
  const [snapshot] = await sql<
    {
      readonly about: string | null;
      readonly accountState: string;
      readonly accountStateChangedAt: Date;
      readonly profileUpdatedAt: Date;
    }[]
  >`
    SELECT
      craftsman_profiles.about,
      users.account_state AS "accountState",
      users.account_state_changed_at AS "accountStateChangedAt",
      craftsman_profiles.updated_at AS "profileUpdatedAt"
    FROM craftsman_profiles
    JOIN users ON users.id = craftsman_profiles.owner_user_id
    WHERE craftsman_profiles.id = ${profile.id}
  `;
  expect(snapshot?.accountState).toBe("SUSPENDED");
  if (editResult.status === "fulfilled") {
    expect(snapshot?.about).toBe("Race-safe edit");
    expect(snapshot?.profileUpdatedAt.valueOf()).toBeLessThanOrEqual(
      snapshot?.accountStateChangedAt.valueOf() ?? 0,
    );
  } else {
    const reason: unknown = editResult.reason;
    expect(reason).toBeInstanceOf(Error);
    expect(reason instanceof Error ? reason.message : String(reason)).toMatch(
      /owner must be ACTIVE/u,
    );
    expect(snapshot?.about).toBeNull();
  }
}
