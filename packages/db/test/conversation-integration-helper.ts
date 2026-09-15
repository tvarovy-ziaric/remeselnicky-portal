import { randomUUID } from "node:crypto";

import type { JobInvitationId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createConversationRepository } from "../src/conversation-repository.js";
import { createJobInvitationRepository } from "../src/job-invitation-repository.js";

interface InvitationFixture {
  readonly craftsmanOwnerId: UserId;
  readonly customerOwnerId: UserId;
  readonly id: JobInvitationId;
  readonly revision: number;
}

/** Runs after notification assertions have consumed the pending invitation. */
export async function runConversationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [invitation] = await sql<InvitationFixture[]>`
    SELECT invitation.id, current.revision,
      customer.owner_user_id AS "customerOwnerId",
      craftsman.owner_user_id AS "craftsmanOwnerId"
    FROM job_invitations invitation
    JOIN current_job_invitations current ON current.id = invitation.id
    JOIN customer_profiles customer
      ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    WHERE current.state = 'PENDING'
    ORDER BY invitation.created_at DESC, invitation.id DESC
    LIMIT 1
  `;
  if (invitation === undefined) {
    throw new Error("R3-011 requires the pending invitation fixture.");
  }

  const conversations = createConversationRepository(sql);
  await expect(
    conversations.readOwnedByInvitation({
      actorUserId: invitation.customerOwnerId,
      invitationId: invitation.id,
    }),
  ).resolves.toBeNull();
  await expect(
    sql`INSERT INTO conversations (invitation_id) VALUES (${invitation.id})`,
  ).rejects.toThrow(/historically engaged invitation/u);

  const engageCommandId = randomUUID();
  const invitations = createJobInvitationRepository(sql);
  const engaged = await invitations.respondOwned({
    action: "ENGAGE",
    actorUserId: invitation.craftsmanOwnerId,
    commandId: engageCommandId,
    expectedRevision: invitation.revision,
    invitationId: invitation.id,
  });
  expect(engaged).toMatchObject({
    invitation: { state: "ENGAGED" },
    status: "APPLIED",
  });

  const customerView = await conversations.readOwnedByInvitation({
    actorUserId: invitation.customerOwnerId,
    invitationId: invitation.id,
  });
  if (customerView === null) throw new Error("Conversation was not created.");
  expect(customerView).toMatchObject({
    access: "WRITABLE",
    invitationId: invitation.id,
    participantRole: "CUSTOMER",
  });
  await expect(
    conversations.readOwned({
      actorUserId: invitation.craftsmanOwnerId,
      conversationId: customerView.id,
    }),
  ).resolves.toMatchObject({
    access: "WRITABLE",
    participantRole: "CRAFTSMAN",
  });

  const outsiderId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${outsiderId})`;
  await expect(
    conversations.readOwned({
      actorUserId: outsiderId,
      conversationId: customerView.id,
    }),
  ).resolves.toBeNull();
  const [count] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM conversations
    WHERE invitation_id = ${invitation.id}
  `;
  expect(count?.count).toBe(1);

  await expect(
    invitations.respondOwned({
      action: "ENGAGE",
      actorUserId: invitation.craftsmanOwnerId,
      commandId: engageCommandId,
      expectedRevision: invitation.revision,
      invitationId: invitation.id,
    }),
  ).resolves.toMatchObject({ status: "DEDUPLICATED" });

  const closed = await invitations.closeOwned({
    action: "STOP_CONSIDERING",
    actorUserId: invitation.customerOwnerId,
    commandId: randomUUID(),
    expectedRevision: invitation.revision + 1,
    invitationId: invitation.id,
  });
  expect(closed).toMatchObject({
    invitation: { state: "NOT_SELECTED" },
    status: "APPLIED",
  });
  await expect(
    conversations.readOwned({
      actorUserId: invitation.customerOwnerId,
      conversationId: customerView.id,
    }),
  ).resolves.toMatchObject({ access: "READ_ONLY" });

  await sql`
    UPDATE users SET account_state = 'SUSPENDED',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${invitation.craftsmanOwnerId}
  `;
  await expect(
    conversations.readOwned({
      actorUserId: invitation.craftsmanOwnerId,
      conversationId: customerView.id,
    }),
  ).resolves.toBeNull();
  await sql`
    UPDATE users SET account_state = 'ACTIVE',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${invitation.craftsmanOwnerId}
  `;

  await expect(
    sql`UPDATE conversations SET created_at = clock_timestamp()
      WHERE id = ${customerView.id}`,
  ).rejects.toThrow(/append-only/u);
  await expect(
    sql`DELETE FROM conversations WHERE id = ${customerView.id}`,
  ).rejects.toThrow(/append-only/u);
}
