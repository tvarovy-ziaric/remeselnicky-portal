import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobParticipantCapabilityRepository,
  JobParticipantCapabilityIdempotencyError,
} from "../src/job-participant-capability-repository.js";

const actorUserId = "86200000-0000-4000-8000-000000000001";
const participantId = "86200000-0000-4000-8000-000000000002";
const jobId = "86200000-0000-4000-8000-000000000003";
const commandId = "86200000-0000-4000-8000-000000000004";
const claimId = "86200000-0000-4000-8000-000000000005";
const proposedAt = new Date("2026-09-16T18:00:00.000Z");
const party = {
  jobId,
  providerUserId: actorUserId,
  targetUserId: participantId,
  isResponsible: false,
};

describe("Job participant capability repository", () => {
  it("rejects malformed variants, unsafe custom text and unbounded reads before SQL", async () => {
    const fixture = fakeSql([]);
    const repository = createJobParticipantCapabilityRepository(fixture.sql);
    await expect(
      repository.propose({
        actorUserId,
        commandId,
        participantId,
        kind: "PROFESSION",
        professionCode: "bad",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.propose({
        actorUserId,
        commandId,
        participantId,
        kind: "PROFESSION",
        professionCode: "TEST:WORK",
        skillCode: "TEST:SKILL",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.propose({
        actorUserId,
        commandId,
        participantId,
        kind: "CUSTOM_SKILL",
        customSkillText: "x@y.sk",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.propose({
        actorUserId,
        commandId,
        participantId,
        kind: "CUSTOM_SKILL",
        customSkillText: " Rucne omietanie ",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.confirm({
        actorUserId,
        commandId,
        participantId,
        claimId: "bad",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.list({ actorUserId, participantId, limit: 51 }),
    ).rejects.toThrow(TypeError);
    expect(fixture.statements).toEqual([]);
  });

  it("authorizes before disclosing claims or creating a proposal", async () => {
    const read = fakeSql([[]]);
    expect(
      await createJobParticipantCapabilityRepository(read.sql).list({
        actorUserId,
        participantId,
        limit: 20,
      }),
    ).toBeNull();
    expect(read.statements).toHaveLength(1);
    const write = fakeSql([[], []]);
    expect(
      await createJobParticipantCapabilityRepository(write.sql).propose({
        actorUserId,
        commandId,
        participantId,
        kind: "PROFESSION",
        professionCode: "TEST:WORK",
      }),
    ).toEqual({ status: "NOT_FOUND" });
    expect(
      write.statements.some((statement) => statement.includes("INSERT INTO")),
    ).toBe(false);
  });

  it("deduplicates only the same actor, participant and exact payload", async () => {
    const existing = {
      participantId,
      kind: "CUSTOM_SKILL",
      professionCode: null,
      skillCode: null,
      customSkillText: "Omietanie",
      proposedByUserId: actorUserId,
      proposedAt,
    };
    const retry = fakeSql([[], [party], [], [], [existing]]);
    const repository = createJobParticipantCapabilityRepository(retry.sql);
    expect(
      await repository.propose({
        actorUserId,
        commandId,
        participantId,
        kind: "CUSTOM_SKILL",
        customSkillText: "Omietanie",
      }),
    ).toEqual({
      status: "DEDUPLICATED",
      claimId: commandId,
      claimStatus: "PROPOSED",
      proposedAt,
    });
    expect(
      retry.statements.some((statement) => statement.includes("INSERT INTO")),
    ).toBe(false);
    const conflict = fakeSql([[], [party], [], [], [existing]]);
    await expect(
      createJobParticipantCapabilityRepository(conflict.sql).propose({
        actorUserId,
        commandId,
        participantId,
        kind: "CUSTOM_SKILL",
        customSkillText: "Tesárstvo",
      }),
    ).rejects.toThrow(JobParticipantCapabilityIdempotencyError);
  });

  it("refuses self-confirmation and a stale participation without inserting evidence", async () => {
    const self = fakeSql([
      [],
      [party],
      [],
      [],
      [{ id: claimId, proposedByUserId: actorUserId }],
    ]);
    expect(
      await createJobParticipantCapabilityRepository(self.sql).confirm({
        actorUserId,
        commandId,
        participantId,
        claimId,
      }),
    ).toEqual({ status: "NOT_FOUND" });
    expect(
      self.statements.some((statement) => statement.includes("INSERT INTO")),
    ).toBe(false);
    const stale = fakeSql([
      [],
      [party],
      [],
      [],
      [{ id: claimId, proposedByUserId: participantId }],
      [],
      [],
    ]);
    expect(
      await createJobParticipantCapabilityRepository(stale.sql).confirm({
        actorUserId,
        commandId,
        participantId,
        claimId,
      }),
    ).toEqual({ status: "STALE_STATE" });
    expect(
      stale.statements.some((statement) => statement.includes("INSERT INTO")),
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
