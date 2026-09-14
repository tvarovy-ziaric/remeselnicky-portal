import { randomUUID } from "node:crypto";

import type {
  AddIndicativePricingEntryInput,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  IndicativePricingEntryId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createIndicativePricingRepository } from "../src/indicative-pricing-repository.js";

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runIndicativePricingIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [taxonomyProfession] = await sql<
    { readonly professionCode: string; readonly releaseId: string }[]
  >`
    SELECT
      profession.profession_code AS "professionCode",
      profession.release_id AS "releaseId"
    FROM profession_taxonomy_activation_events activation
    JOIN taxonomy_professions profession
      ON profession.release_id = activation.release_id
    JOIN profession_taxonomy_releases release
      ON release.release_id = profession.release_id
    WHERE profession.state = 'ACTIVE'
      AND release.content_class = 'CANONICAL'
      AND release.review_state = 'HUMAN_REVIEW_APPROVED'
    ORDER BY activation.activation_sequence DESC, profession.profession_code
    LIMIT 1
  `;
  if (taxonomyProfession === undefined) {
    throw new Error(
      "Indicative pricing integration requires the activated synthetic taxonomy fixture.",
    );
  }

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [otherOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (
    owner === undefined ||
    otherOwner === undefined ||
    nonOwner === undefined
  ) {
    throw new Error("Expected indicative pricing integration users.");
  }

  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  const [otherProfile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${otherOwner.id}, 'COMPANY')
    RETURNING id
  `;
  if (profile === undefined || otherProfile === undefined) {
    throw new Error("Expected indicative pricing integration profiles.");
  }

  const professionRepository = createCraftsmanProfessionRepository(sql);
  const professionId = randomUUID() as CraftsmanProfessionId;
  const otherProfessionId = randomUUID() as CraftsmanProfessionId;
  await expect(
    professionRepository.assign({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "BEGINNER",
      professionCode: taxonomyProfession.professionCode,
      taxonomyReleaseId: taxonomyProfession.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    professionRepository.assign({
      actorUserId: otherOwner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: otherProfessionId,
      craftsmanProfileId: otherProfile.id,
      declaredLevel: "BEGINNER",
      professionCode: taxonomyProfession.professionCode,
      taxonomyReleaseId: taxonomyProfession.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const repository = createIndicativePricingRepository(sql);
  const base = addInput(owner.id, profile.id);
  const concurrentAdd = await Promise.all([
    repository.add(base),
    repository.add(base),
  ]);
  expect(concurrentAdd.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);

  await expect(
    repository.add({ ...addInput(nonOwner.id, profile.id) }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.add({
      ...addInput(owner.id, profile.id),
      craftsmanProfessionId: otherProfessionId,
    }),
  ).resolves.toEqual({ status: "PROFESSION_UNAVAILABLE" });

  const linkedInput = {
    ...addInput(owner.id, profile.id),
    craftsmanProfessionId: professionId,
    serviceName: "Servis rozvodu 230/400 V",
  };
  await expect(repository.add(linkedInput)).resolves.toMatchObject({
    entry: { craftsmanProfessionId: professionId },
    status: "APPLIED",
  });

  const competingEdits = await Promise.all([
    repository.edit({
      actorUserId: owner.id,
      amountCents: 14_900,
      commandId: randomUUID(),
      craftsmanProfessionId: null,
      craftsmanProfileId: profile.id,
      entryId: base.entryId,
      expectedRevision: 1,
      note: "Bežný materiál je zahrnutý",
      priceMode: "APPROXIMATE",
      serviceName: "Montáž batérie",
    }),
    repository.edit({
      actorUserId: owner.id,
      amountCents: 15_900,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
      entryId: base.entryId,
      expectedRevision: 1,
      note: null,
      priceMode: "PER_UNIT",
      serviceName: "Montáž batérie",
    }),
  ]);
  expect(competingEdits.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);

  const appliedEdit = competingEdits.find(({ status }) => status === "APPLIED");
  if (appliedEdit?.status !== "APPLIED") {
    throw new Error("Expected one applied indicative pricing edit.");
  }
  const archiveCommand = {
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    entryId: base.entryId,
    expectedRevision: appliedEdit.entry.revision,
  } as const;
  await expect(repository.archive(archiveCommand)).resolves.toMatchObject({
    entry: { state: "ARCHIVED" },
    status: "APPLIED",
  });
  await expect(repository.archive(archiveCommand)).resolves.toMatchObject({
    entry: { state: "ARCHIVED" },
    status: "DEDUPLICATED",
  });
  await expect(repository.add(base)).resolves.toMatchObject({
    entry: { revision: 1, state: "ACTIVE" },
    status: "DEDUPLICATED",
  });
  await expect(
    repository.edit({
      actorUserId: owner.id,
      amountCents: 9_000,
      commandId: randomUUID(),
      craftsmanProfessionId: null,
      craftsmanProfileId: profile.id,
      entryId: base.entryId,
      expectedRevision: appliedEdit.entry.revision + 1,
      note: null,
      priceMode: "OTHER",
      serviceName: "Zakázaná obnova",
    }),
  ).resolves.toEqual({ status: "ENTRY_ARCHIVED" });

  const activeRows = await repository.listOwned({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
  });
  expect(activeRows.map(({ id }) => id)).toEqual([linkedInput.entryId]);
  const history = await repository.listOwned({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    includeArchived: true,
  });
  expect(history).toHaveLength(2);
  expect(history).toEqual(
    [...history].sort(
      (left, right) =>
        left.createdAt.valueOf() - right.createdAt.valueOf() ||
        left.id.localeCompare(right.id),
    ),
  );
  await expect(
    repository.listOwned({
      actorUserId: nonOwner.id,
      craftsmanProfileId: profile.id,
      includeArchived: true,
    }),
  ).resolves.toEqual([]);

  await expect(
    professionRepository.deactivate({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.add({
      ...addInput(owner.id, profile.id),
      craftsmanProfessionId: professionId,
      serviceName: "Neaktívna profesia",
    }),
  ).resolves.toEqual({ status: "PROFESSION_UNAVAILABLE" });

  for (const unsafe of [
    "Kontakt majster@example.sk",
    "Správa cez @majster_jano",
    "Volajte +421 900 123 456",
    "Web https://example.sk",
    "Web remeslo.sk",
    "Adresa: Hlavná 12, 811 01",
    "heslo: tajne",
  ]) {
    await expect(sql`
      INSERT INTO indicative_pricing_entries (
        id,
        craftsman_profile_id,
        service_name,
        price_mode,
        amount_cents,
        note,
        latest_command_id,
        created_by_user_id,
        updated_by_user_id
      ) VALUES (
        ${randomUUID()},
        ${profile.id},
        'Bezpečný názov',
        'FROM',
        100,
        ${unsafe},
        ${randomUUID()},
        ${owner.id},
        ${owner.id}
      )
    `).rejects.toThrow(/indicative_pricing_note_safe/u);
  }

  await expect(sql`
    INSERT INTO indicative_pricing_entries (
      id,
      craftsman_profile_id,
      service_name,
      price_mode,
      amount_cents,
      latest_command_id,
      created_by_user_id,
      updated_by_user_id
    ) VALUES (
      ${randomUUID()},
      ${profile.id},
      'Objednajte cez www.example.sk',
      'FROM',
      100,
      ${randomUUID()},
      ${owner.id},
      ${owner.id}
    )
  `).rejects.toThrow(/indicative_pricing_service_name_safe/u);

  await expect(sql`
    INSERT INTO indicative_pricing_entries (
      id,
      craftsman_profile_id,
      service_name,
      price_mode,
      amount_cents,
      latest_command_id,
      created_by_user_id,
      updated_by_user_id
    ) VALUES (
      ${randomUUID()},
      ${profile.id},
      'Neoprávnený zápis',
      'FROM',
      100,
      ${randomUUID()},
      ${nonOwner.id},
      ${nonOwner.id}
    )
  `).rejects.toThrow(/active indicative pricing profile owner required/u);

  await expect(sql`
    INSERT INTO indicative_pricing_entries (
      id,
      craftsman_profile_id,
      service_name,
      price_mode,
      amount_cents,
      latest_command_id,
      created_by_user_id,
      updated_by_user_id
    ) VALUES (
      ${randomUUID()},
      ${profile.id},
      'Neplatná nulová cena',
      'FROM',
      0,
      ${randomUUID()},
      ${owner.id},
      ${owner.id}
    )
  `).rejects.toThrow(/indicative_pricing_amount_positive_safe_integer/u);

  for (const unavailableProfessionId of [professionId, otherProfessionId]) {
    await expect(sql`
      INSERT INTO indicative_pricing_entries (
        id,
        craftsman_profile_id,
        craftsman_profession_id,
        service_name,
        price_mode,
        amount_cents,
        latest_command_id,
        created_by_user_id,
        updated_by_user_id
      ) VALUES (
        ${randomUUID()},
        ${profile.id},
        ${unavailableProfessionId},
        'Nedostupná profesia',
        'FROM',
        100,
        ${randomUUID()},
        ${owner.id},
        ${owner.id}
      )
    `).rejects.toThrow(
      /profession must be active and owned by the same profile/u,
    );
  }

  await expect(sql`
    UPDATE indicative_pricing_entries
    SET amount_cents = amount_cents + 1
    WHERE id = ${linkedInput.entryId}
  `).rejects.toThrow(/requires a new command/u);
  await expect(sql`
    DELETE FROM indicative_pricing_entries
    WHERE id = ${linkedInput.entryId}
  `).rejects.toThrow(/history cannot be hard-deleted/u);
  await expect(sql`
    UPDATE indicative_pricing_entry_revisions
    SET amount_cents = amount_cents + 1
    WHERE entry_id = ${linkedInput.entryId}
  `).rejects.toThrow(/revision history is append-only/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO indicative_pricing_commands (
          command_id,
          command_kind,
          entry_id,
          craftsman_profile_id,
          actor_user_id,
          payload_fingerprint
        ) VALUES (
          ${randomUUID()},
          'EDIT',
          ${linkedInput.entryId},
          ${profile.id},
          ${owner.id},
          ${"e".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/requires exactly one matching revision effect/u);

  await runSuspensionAddRace(sql);
}

function addInput(
  actorUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
): AddIndicativePricingEntryInput {
  return {
    actorUserId,
    amountCents: 12_500,
    commandId: randomUUID(),
    craftsmanProfileId,
    entryId: randomUUID() as IndicativePricingEntryId,
    note: null,
    priceMode: "FROM",
    serviceName: "Montáž batérie",
  };
}

async function runSuspensionAddRace(sql: Sql): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected pricing race-test owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected pricing race profile.");

  const input = addInput(owner.id, profile.id);
  const [addResult] = await Promise.all([
    createIndicativePricingRepository(sql).add(input),
    sql`
      UPDATE users
      SET
        account_state = 'SUSPENDED',
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE users.id = ${owner.id}
    `,
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(addResult.status);

  const [evidence] = await sql<
    {
      readonly accountStateChangedAt: Date;
      readonly commandCount: number;
      readonly createdAt: Date | null;
      readonly revisionCount: number;
    }[]
  >`
    SELECT
      owner.account_state_changed_at AS "accountStateChangedAt",
      entry.created_at AS "createdAt",
      count(DISTINCT command.command_id)::integer AS "commandCount",
      count(DISTINCT history.command_id)::integer AS "revisionCount"
    FROM users owner
    LEFT JOIN indicative_pricing_entries entry ON entry.id = ${input.entryId}
    LEFT JOIN indicative_pricing_commands command ON command.entry_id = entry.id
    LEFT JOIN indicative_pricing_entry_revisions history ON history.entry_id = entry.id
    WHERE owner.id = ${owner.id}
    GROUP BY owner.account_state_changed_at, entry.created_at
  `;
  if (evidence === undefined)
    throw new Error("Expected pricing race evidence.");
  const expectedEffects = addResult.status === "APPLIED" ? 1 : 0;
  expect(evidence.commandCount).toBe(expectedEffects);
  expect(evidence.revisionCount).toBe(expectedEffects);
  if (evidence.createdAt !== null) {
    expect(evidence.createdAt.valueOf()).toBeLessThanOrEqual(
      evidence.accountStateChangedAt.valueOf(),
    );
  }
}
