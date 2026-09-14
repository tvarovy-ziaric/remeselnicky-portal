import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  CustomerProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCustomerShortlistRepository } from "../src/customer-shortlist-repository.js";

/** Standalone R2-012 checks; root wires this after the existing R2 helpers. */
export async function runCustomerShortlistIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const candidates = await sql<
    { readonly ownerUserId: UserId; readonly profileId: CraftsmanProfileId }[]
  >`
    SELECT profile.owner_user_id AS "ownerUserId",
      searchable.craftsman_profile_id AS "profileId"
    FROM current_searchable_craftsman_profiles searchable
    JOIN craftsman_profiles profile ON profile.id = searchable.craftsman_profile_id
    ORDER BY searchable.craftsman_profile_id
    LIMIT 2
  `;
  if (candidates.length !== 2) {
    throw new Error(
      "R2 shortlist integration needs two searchable synthetic profiles.",
    );
  }
  const [first, second] = candidates;
  if (first === undefined || second === undefined)
    throw new Error("Missing candidates.");
  const customers = new Map<string, CustomerProfileId>();
  for (const candidate of candidates) {
    const [customer] = await sql<{ readonly id: CustomerProfileId }[]>`
      INSERT INTO customer_profiles (owner_user_id)
      VALUES (${candidate.ownerUserId})
      ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = customer_profiles.updated_at
      RETURNING id
    `;
    if (customer === undefined)
      throw new Error("Expected customer capability.");
    customers.set(candidate.ownerUserId, customer.id);
  }
  const firstCustomer = customers.get(first.ownerUserId);
  const secondCustomer = customers.get(second.ownerUserId);
  if (firstCustomer === undefined || secondCustomer === undefined)
    throw new Error("Missing customers.");

  const repository = createCustomerShortlistRepository(sql);
  const absentRemoveId = randomUUID();
  await expect(
    repository.removeOwned({
      actorUserId: first.ownerUserId,
      commandId: absentRemoveId,
      craftsmanProfileId: second.profileId,
      customerProfileId: firstCustomer,
    }),
  ).resolves.toMatchObject({
    revision: 0,
    state: "REMOVED",
    status: "UNCHANGED",
  });
  await expect(
    repository.addOwned({
      actorUserId: first.ownerUserId,
      commandId: randomUUID(),
      craftsmanProfileId: second.profileId,
      customerProfileId: firstCustomer,
    }),
  ).resolves.toMatchObject({
    activeShortlistSize: 1,
    state: "ACTIVE",
    status: "APPLIED",
  });
  await expect(
    repository.removeOwned({
      actorUserId: first.ownerUserId,
      commandId: absentRemoveId,
      craftsmanProfileId: second.profileId,
      customerProfileId: firstCustomer,
    }),
  ).resolves.toMatchObject({
    revision: 0,
    state: "REMOVED",
    status: "DEDUPLICATED",
  });
  await expect(repository.listOwned(first.ownerUserId)).resolves.toMatchObject({
    entries: [{ craftsmanProfileId: second.profileId, state: "ACTIVE" }],
    status: "OK",
  });

  await expect(
    Promise.all([
      repository.addOwned({
        actorUserId: first.ownerUserId,
        commandId: randomUUID(),
        craftsmanProfileId: second.profileId,
        customerProfileId: firstCustomer,
      }),
      repository.addOwned({
        actorUserId: second.ownerUserId,
        commandId: randomUUID(),
        craftsmanProfileId: first.profileId,
        customerProfileId: secondCustomer,
      }),
    ]),
  ).resolves.toHaveLength(2);

  await expect(
    Promise.all([
      repository.addOwned({
        actorUserId: first.ownerUserId,
        commandId: randomUUID(),
        craftsmanProfileId: second.profileId,
        customerProfileId: firstCustomer,
      }),
      repository.removeOwned({
        actorUserId: first.ownerUserId,
        commandId: randomUUID(),
        craftsmanProfileId: second.profileId,
        customerProfileId: firstCustomer,
      }),
    ]),
  ).resolves.toHaveLength(2);

  const [hiddenOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [suspendedOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users (account_state) VALUES ('SUSPENDED') RETURNING id
  `;
  if (hiddenOwner === undefined || suspendedOwner === undefined)
    throw new Error("Expected negative users.");
  for (const owner of [hiddenOwner, suspendedOwner]) {
    const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
      INSERT INTO craftsman_profiles (owner_user_id, profile_type)
      VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
    `;
    if (profile === undefined) throw new Error("Expected negative target.");
    const commandId = randomUUID();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          actorUserId: first.ownerUserId,
          commandKind: "ADD",
          craftsmanProfileId: profile.id,
        }),
      )
      .digest("hex");
    await expect(sql`
      INSERT INTO customer_shortlist_commands (
        command_id, customer_profile_id, craftsman_profile_id, actor_user_id,
        command_kind, expected_revision, result_kind, resulting_revision,
        target_state, payload_fingerprint
      ) VALUES (
        ${commandId}, ${firstCustomer}, ${profile.id}, ${first.ownerUserId},
        'ADD', 0, 'APPLIED', 1, 'ACTIVE', ${fingerprint}
      )
    `).rejects.toThrow(/public approved active craftsman/u);
  }
}
