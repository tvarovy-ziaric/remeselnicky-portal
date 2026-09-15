import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import type { ConversationId, JobInvitationId, UserId } from "@portal/domain";

import { createConversationRepository } from "../src/conversation-repository.js";

const actorUserId = "9e100000-0000-4000-8000-000000000001" as UserId;
const conversationId = "9e100000-0000-4000-8000-000000000002" as ConversationId;
const invitationId = "9e100000-0000-4000-8000-000000000003" as JobInvitationId;

describe("conversation repository", () => {
  it("reads only an ACTIVE exact participant and returns the allowlisted identity", async () => {
    const rows = [
      {
        access: "WRITABLE",
        counterpartDisplayName: "Majster Test",
        craftsmanProfileId: "9e100000-0000-4000-8000-000000000004",
        createdAt: new Date("2026-09-15T08:00:00Z"),
        customerProfileId: "9e100000-0000-4000-8000-000000000005",
        id: conversationId,
        invitationId,
        jobRequestId: "9e100000-0000-4000-8000-000000000006",
        participantRole: "CUSTOMER",
        requestTitle: "Oprava strechy",
      },
    ];
    const statements: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve(rows);
    }) as unknown as Sql;

    await expect(
      createConversationRepository(sql).readOwned({
        actorUserId,
        conversationId,
      }),
    ).resolves.toMatchObject({
      access: "WRITABLE",
      counterpartDisplayName: "Majster Test",
      participantRole: "CUSTOMER",
    });
    expect(statements[0]).toContain("actor.account_state = 'ACTIVE'");
    expect(statements[0]).toContain("customer.owner_user_id = actor.id");
    expect(statements[0]).toContain("craftsman.owner_user_id = actor.id");
    expect(statements[0]).toContain("JOIN users actor");
    expect(statements[0]).not.toContain("email");
    expect(statements[0]).not.toContain("phone");
    expect(statements[0]).not.toContain("section.payload");
  });

  it("uses the same participant boundary for invitation lookup", async () => {
    const statements: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve([]);
    }) as unknown as Sql;
    await expect(
      createConversationRepository(sql).readOwnedByInvitation({
        actorUserId,
        invitationId,
      }),
    ).resolves.toBeNull();
    expect(statements[0]).toContain("current.invitation_id =");
  });

  it("fails closed on malformed persisted access state", async () => {
    const sql = (() =>
      Promise.resolve([
        {
          access: "OPEN_TO_EVERYONE",
          counterpartDisplayName: "Majster Test",
          craftsmanProfileId: "9e100000-0000-4000-8000-000000000004",
          createdAt: new Date(),
          customerProfileId: "9e100000-0000-4000-8000-000000000005",
          id: conversationId,
          invitationId,
          jobRequestId: "9e100000-0000-4000-8000-000000000006",
          participantRole: "CUSTOMER",
          requestTitle: "Oprava",
        },
      ])) as unknown as Sql;
    await expect(
      createConversationRepository(sql).readOwned({
        actorUserId,
        conversationId,
      }),
    ).rejects.toThrow("Corrupt conversation projection");
  });
});
