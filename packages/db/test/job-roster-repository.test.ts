import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobRosterRepository } from "../src/job-roster-repository.js";

const customerId = "86200000-0000-4000-8000-000000000001";
const jobId = "86200000-0000-4000-8000-000000000002";
const participantId = "86200000-0000-4000-8000-000000000003";
const profileId = "86200000-0000-4000-8000-000000000004";
const groupId = "86200000-0000-4000-8000-000000000005";
const assignmentId = "86200000-0000-4000-8000-000000000006";
const invitedAt = new Date("2026-09-16T17:00:00.000Z");
const acceptedAt = new Date("2026-09-16T18:00:00.000Z");

function participant(state: "INVITED" | "ACCEPTED" = "ACCEPTED") {
  return {
    id: participantId,
    craftsmanProfileId: profileId,
    nickname: "Skúšobný majster",
    realFirstName: "Never",
    realLastName: "Exposed",
    state,
    invitedAt,
    acceptedAt: state === "ACCEPTED" ? acceptedAt : null,
    leftAt: null,
  };
}

describe("private Job roster read model", () => {
  it("returns accepted history and only public roster fields to the customer", async () => {
    const fixture = fakeSql([
      [{ role: "CUSTOMER" }],
      [participant()],
      [
        {
          participantId,
          role: "MEMBER",
          assignedAt: acceptedAt,
          endedAt: null,
          active: true,
        },
      ],
      [
        {
          participantId,
          assignmentId,
          workGroupId: groupId,
          name: "Pracovná skupina",
          crewName: "Čata",
          assignedAt: acceptedAt,
          endedAt: null,
          active: true,
        },
      ],
    ]);
    const page = await createJobRosterRepository(
      fixture.sql,
    ).listForPrimaryParty({ actorUserId: customerId, jobId, limit: 20 });
    expect(page?.role).toBe("CUSTOMER");
    expect(page?.participants[0]).toEqual({
      id: participantId,
      craftsmanProfileId: profileId,
      displayName: "Skúšobný majster",
      state: "ACCEPTED",
      invitedAt,
      acceptedAt,
      leftAt: null,
      roles: [
        { role: "MEMBER", assignedAt: acceptedAt, endedAt: null, active: true },
      ],
      workGroups: [
        {
          assignmentId,
          workGroupId: groupId,
          name: "Pracovná skupina",
          crewName: "Čata",
          assignedAt: acceptedAt,
          endedAt: null,
          active: true,
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("Never");
    expect(JSON.stringify(page)).not.toContain("participantId");
    expect(fixture.statements[0]).toContain("viewer.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain("FOR SHARE OF viewer, job");
    expect(fixture.statements[1]).toContain(
      "participant.accepted_at IS NOT NULL",
    );
    expect(fixture.statements[1]).toContain(
      "ORDER BY participant.invited_at DESC",
    );
  });

  it("lets the primary provider see unaccepted invitations without verified roles", async () => {
    const fixture = fakeSql([
      [{ role: "PRIMARY_PROVIDER" }],
      [participant("INVITED")],
      [],
      [],
    ]);
    const page = await createJobRosterRepository(
      fixture.sql,
    ).listForPrimaryParty({
      actorUserId: customerId,
      jobId,
      limit: 20,
    });
    expect(page?.participants[0]).toMatchObject({
      state: "INVITED",
      acceptedAt: null,
      roles: [],
      workGroups: [],
    });
  });

  it("uses identical null for unknown and unrelated Jobs", async () => {
    const fixture = fakeSql([[]]);
    expect(
      await createJobRosterRepository(fixture.sql).listForPrimaryParty({
        actorUserId: customerId,
        jobId,
        limit: 20,
      }),
    ).toBeNull();
    expect(fixture.statements).toHaveLength(1);
  });

  it("fails closed on customer pending rows, corrupt chronology and unbounded queries", async () => {
    const repository = createJobRosterRepository(fakeSql([]).sql);
    await expect(
      repository.listForPrimaryParty({
        actorUserId: customerId,
        jobId,
        limit: 51,
      }),
    ).rejects.toThrow("Invalid Job roster query");
    const pending = fakeSql([
      [{ role: "CUSTOMER" }],
      [participant("INVITED")],
      [],
      [],
    ]);
    await expect(
      createJobRosterRepository(pending.sql).listForPrimaryParty({
        actorUserId: customerId,
        jobId,
        limit: 20,
      }),
    ).rejects.toThrow("customer Job roster visibility");
    const corrupt = fakeSql([
      [{ role: "PRIMARY_PROVIDER" }],
      [{ ...participant(), acceptedAt: null }],
      [],
      [],
    ]);
    await expect(
      createJobRosterRepository(corrupt.sql).listForPrimaryParty({
        actorUserId: customerId,
        jobId,
        limit: 20,
      }),
    ).rejects.toThrow("Invalid Job roster participant");
  });
});

function fakeSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  const tagged = (parts: TemplateStringsArray): Promise<readonly unknown[]> => {
    statements.push(parts.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  };
  const sql = Object.assign(tagged, {
    begin: (callback: (transaction: Sql) => Promise<unknown>) => callback(sql),
  }) as unknown as Sql;
  return { sql, statements };
}
