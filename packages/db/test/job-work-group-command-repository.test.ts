import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobWorkGroupCommandRepository,
  JobWorkGroupIdempotencyError,
} from "../src/job-work-group-command-repository.js";

const actorUserId = "86200000-0000-4000-8000-000000000001";
const jobId = "86200000-0000-4000-8000-000000000002";
const workGroupId = "86200000-0000-4000-8000-000000000003";
const participantId = "86200000-0000-4000-8000-000000000004";
const assignmentId = "86200000-0000-4000-8000-000000000005";
const commandId = "86200000-0000-4000-8000-000000000006";
const createdAt = new Date("2026-09-16T18:00:00.000Z");

describe("Job work-group command repository", () => {
  it("rejects malformed command bodies before any database access", async () => {
    const fixture = fakeSql([]);
    const repository = createJobWorkGroupCommandRepository(fixture.sql);
    await expect(
      repository.create({ actorUserId, commandId, jobId, name: "x" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.create({ actorUserId, commandId, jobId, name: "Bad\nname" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.assign({
        actorUserId,
        commandId,
        workGroupId: "bad",
        participantId,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.depart({
        actorUserId,
        commandId,
        assignmentId,
        action: "REMOVE",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.depart({
        actorUserId,
        commandId,
        assignmentId,
        action: "LEAVE",
        reason: "short",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.depart({
        actorUserId,
        commandId,
        assignmentId,
        action: "LEAVE",
        reason: "Dostatočne dlhý dôvod",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listForPrimaryParty({ actorUserId, jobId, limit: 51 }),
    ).rejects.toThrow(TypeError);
    expect(fixture.statements).toEqual([]);
  });

  it("authorizes private lists before reading concrete group identities", async () => {
    const denied = fakeSql([[]]);
    expect(
      await createJobWorkGroupCommandRepository(denied.sql).listForPrimaryParty(
        { actorUserId, jobId, limit: 20 },
      ),
    ).toBeNull();
    expect(denied.statements).toHaveLength(1);
    const fixture = fakeSql([
      [{ id: jobId }],
      [{ id: workGroupId, name: "Montáž", crewName: null, createdAt }],
    ]);
    const result = await createJobWorkGroupCommandRepository(
      fixture.sql,
    ).listForPrimaryParty({ actorUserId, jobId, limit: 20 });
    expect(result).toEqual({
      groups: [{ id: workGroupId, name: "Montáž", crewName: null, createdAt }],
      nextCursor: null,
    });
    expect(fixture.statements[0]).toContain("viewer.account_state = 'ACTIVE'");
    expect(fixture.statements[1]).toContain("FROM job_work_groups group_row");
    expect(fixture.statements[1]).not.toContain("crew_memberships");
  });

  it("fails closed when list provenance is malformed", async () => {
    const fixture = fakeSql([
      [{ id: jobId }],
      [{ id: "invalid", name: "Montáž", crewName: null, createdAt }],
    ]);
    await expect(
      createJobWorkGroupCommandRepository(fixture.sql).listForPrimaryParty({
        actorUserId,
        jobId,
        limit: 20,
      }),
    ).rejects.toThrow("Invalid work-group list provenance");
  });

  it("does not mutate a foreign Job and deduplicates an exact create retry", async () => {
    const denied = fakeSql([[], []]);
    expect(
      await createJobWorkGroupCommandRepository(denied.sql).create({
        actorUserId,
        commandId,
        jobId,
        name: "Montáž",
      }),
    ).toEqual({ status: "NOT_FOUND" });
    expect(
      denied.statements.some((statement) => statement.includes("INSERT INTO")),
    ).toBe(false);
    const existing = { jobId, actorUserId, name: "Montáž", createdAt };
    const retry = fakeSql([[], [{ id: jobId }], [], [existing]]);
    expect(
      await createJobWorkGroupCommandRepository(retry.sql).create({
        actorUserId,
        commandId,
        jobId,
        name: "Montáž",
      }),
    ).toEqual({ status: "DEDUPLICATED", workGroupId: commandId, createdAt });
    expect(
      retry.statements.some((statement) => statement.includes("INSERT INTO")),
    ).toBe(false);
    const conflict = fakeSql([[], [{ id: jobId }], [], [existing]]);
    await expect(
      createJobWorkGroupCommandRepository(conflict.sql).create({
        actorUserId,
        commandId,
        jobId,
        name: "Opravy",
      }),
    ).rejects.toThrow(JobWorkGroupIdempotencyError);
  });

  it("never assigns an unaccepted participant or departs as a foreign actor", async () => {
    const unaccepted = fakeSql([
      [],
      [{ jobId }],
      [{ id: jobId }],
      [],
      [],
      [{ state: "INVITED" }],
    ]);
    expect(
      await createJobWorkGroupCommandRepository(unaccepted.sql).assign({
        actorUserId,
        commandId,
        workGroupId,
        participantId,
      }),
    ).toEqual({ status: "STALE_STATE" });
    expect(
      unaccepted.statements.some((statement) =>
        statement.includes("INSERT INTO"),
      ),
    ).toBe(false);
    const foreign = fakeSql([
      [],
      [{ jobId, ownerUserId: participantId, providerUserId: workGroupId }],
    ]);
    expect(
      await createJobWorkGroupCommandRepository(foreign.sql).depart({
        actorUserId,
        commandId,
        assignmentId,
        action: "LEAVE",
      }),
    ).toEqual({ status: "NOT_FOUND" });
    expect(
      foreign.statements.some((statement) => statement.includes("INSERT INTO")),
    ).toBe(false);
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
