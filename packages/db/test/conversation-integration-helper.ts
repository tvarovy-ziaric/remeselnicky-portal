import { randomUUID } from "node:crypto";

import type { ConversationId, JobInvitationId, UserId } from "@portal/domain";
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

/** Runs after the request lifecycle helper closes its engaged invitation. */
export async function runConversationReadOnlyIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<
    Array<{
      readonly actorUserId: UserId;
      readonly conversationId: string;
    }>
  >`
    SELECT customer.owner_user_id AS "actorUserId",
      conversation.id AS "conversationId"
    FROM current_conversations conversation
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    WHERE conversation.access_state = 'READ_ONLY'
      AND conversation.invitation_state IN ('WITHDRAWN', 'NOT_SELECTED')
    ORDER BY conversation.created_at DESC, conversation.id DESC
    LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error("R3-011 requires terminal conversation history.");
  }
  await expect(
    createConversationRepository(sql).readOwned({
      actorUserId: fixture.actorUserId,
      conversationId: fixture.conversationId as ConversationId,
    }),
  ).resolves.toMatchObject({ access: "READ_ONLY" });
}
