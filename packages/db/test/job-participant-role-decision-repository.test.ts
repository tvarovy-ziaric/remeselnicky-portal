import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobParticipantRoleDecisionRepository,
  JobParticipantRoleDecisionIdempotencyError,
} from "../src/job-participant-role-decision-repository.js";

const actorUserId = "86200000-0000-4000-8000-000000000001";
const participantId = "86200000-0000-4000-8000-000000000002";
const jobId = "86200000-0000-4000-8000-000000000003";
const assignmentEventId = "86200000-0000-4000-8000-000000000004";
const commandId = "86200000-0000-4000-8000-000000000005";
const assignedAt = new Date("2026-09-16T08:00:00.000Z");
const decidedAt = new Date("2026-09-16T09:00:00.000Z");

interface FixtureOptions {
  readonly authorized?: boolean;
  readonly assignment?: boolean;
  readonly assignmentActor?: string;
  readonly active?: boolean;
  readonly existing?: Record<string, unknown>;
  readonly prior?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const statements: string[] = [];
  const values: readonly unknown[][] = [];
  const query = (
    parts: TemplateStringsArray,
    ...parameters: unknown[]
  ): Promise<readonly unknown[]> => {
    const statement = parts.join("?");
    statements.push(statement);
    (values as unknown[][]).push(parameters);
    if (statement.includes("FROM job_participants\n"))
      return Promise.resolve([{ jobId }]);
    if (
      statement.includes("FROM job_participant_role_events\n") &&
      statement.includes("FOR UPDATE")
    )
      return Promise.resolve(
        options.assignment === false
          ? []
          : [
              {
                participantId,
                actorUserId: options.assignmentActor ?? commandId,
              },
            ],
      );
    if (statement.includes("SELECT participant.id FROM job_participants"))
      return Promise.resolve(
        options.authorized === false ? [] : [{ id: participantId }],
      );
    if (
      statement.includes("FROM job_participant_role_decisions\n") &&
      statement.includes("WHERE decision_id")
    )
      return Promise.resolve(
        options.existing === undefined ? [] : [options.existing],
      );
    if (statement.includes("FROM job_participant_role_intervals"))
      return Promise.resolve([{ active: options.active !== false }]);
    if (
      statement.includes("WHERE assignment_event_id") &&
      statement.includes("FROM job_participant_role_decisions")
    )
      return Promise.resolve(options.prior ? [{ decisionId: commandId }] : []);
    if (statement.includes("INSERT INTO job_participant_role_decisions"))
      return Promise.resolve([{ decidedAt }]);
    if (statement.includes("FROM job_participant_role_events assignment"))
      return Promise.resolve([
        { assignmentEventId, participantId, role: "LEAD", assignedAt },
      ]);
    return Promise.resolve([]);
  };
  const tx = query as unknown as TransactionSql;
  const sql = Object.assign(query, {
    begin: async <T>(callback: (transaction: TransactionSql) => Promise<T>) =>
      callback(tx),
  }) as unknown as Sql;
  return { sql, statements, values };
}

const confirmation = {
  actorUserId,
  commandId,
  participantId,
  assignmentEventId,
  decision: "CONFIRM" as const,
};

describe("Job participant role decisions", () => {
  it("rejects malformed identifiers and unsafe correction text before querying", async () => {
    const fake = fixture();
    const repository = createJobParticipantRoleDecisionRepository(fake.sql);
    await expect(
      repository.listPending({ actorUserId, participantId: "bad" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.decide({ ...confirmation, commandId: "bad" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.decide({
        ...confirmation,
        decision: "REQUEST_CORRECTION",
        reason: "too few",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.decide({
        ...confirmation,
        decision: "REQUEST_CORRECTION",
        reason: "Wrong role\nplease fix",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.decide({
        ...confirmation,
        decision: "REQUEST_CORRECTION",
        reason: "x".repeat(501),
      }),
    ).rejects.toThrow(TypeError);
    expect(fake.statements).toEqual([]);
  });

  it("returns null for unrelated viewers and only current undecided assignments", async () => {
    const denied = fixture({ authorized: false });
    await expect(
      createJobParticipantRoleDecisionRepository(denied.sql).listPending({
        actorUserId,
        participantId,
      }),
    ).resolves.toBeNull();
    expect(denied.statements).toHaveLength(1);
    const allowed = fixture();
    await expect(
      createJobParticipantRoleDecisionRepository(allowed.sql).listPending({
        actorUserId,
        participantId,
      }),
    ).resolves.toEqual([
      { assignmentEventId, participantId, role: "LEAD", assignedAt },
    ]);
    expect(allowed.statements.join("\n")).toContain("role_interval.active");
    expect(allowed.statements.join("\n")).toContain(
      "decision.decision_id IS NULL",
    );
    expect(allowed.statements.join("\n")).toContain(
      "current.verified_participation",
    );
  });

  it("confirms an exact assignment under Job and assignment locks", async () => {
    const fake = fixture();
    await expect(
      createJobParticipantRoleDecisionRepository(fake.sql).decide(confirmation),
    ).resolves.toEqual({
      status: "APPLIED",
      decisionId: commandId,
      decision: "CONFIRM",
      decidedAt,
    });
    const statements = fake.statements.join("\n");
    expect(statements).toContain("pg_advisory_xact_lock");
    expect(statements).toContain("FROM jobs WHERE id = ? FOR UPDATE");
    expect(statements).toContain("AND action = 'ASSIGN'\n          FOR UPDATE");
    expect(statements).toContain("INSERT INTO job_participant_role_decisions");
  });

  it("records a participant correction request without manufacturing verification", async () => {
    const fake = fixture({ assignmentActor: actorUserId });
    await expect(
      createJobParticipantRoleDecisionRepository(fake.sql).decide({
        ...confirmation,
        decision: "REQUEST_CORRECTION",
        reason: "  I did not coordinate this work  ",
      }),
    ).resolves.toEqual({
      status: "APPLIED",
      decisionId: commandId,
      decision: "REQUEST_CORRECTION",
      decidedAt,
    });
    const insertAt = fake.statements.findIndex((statement) =>
      statement.includes("INSERT INTO job_participant_role_decisions"),
    );
    expect(fake.values[insertAt]).toContain("I did not coordinate this work");
  });

  it("does not reveal unrelated assignments or allow inactive participants", async () => {
    for (const options of [
      { assignment: false },
      { authorized: false },
      { active: false },
    ]) {
      const fake = fixture(options);
      const result = await createJobParticipantRoleDecisionRepository(
        fake.sql,
      ).decide(confirmation);
      expect(result.status).toBe(
        options.active === false ? "STALE_STATE" : "NOT_FOUND",
      );
      expect(fake.statements.join("\n")).not.toContain(
        "INSERT INTO job_participant_role_decisions",
      );
    }
  });

  it("rejects self-assignment confirmation and another decision on the same assignment", async () => {
    const self = fixture({ assignmentActor: actorUserId });
    await expect(
      createJobParticipantRoleDecisionRepository(self.sql).decide(confirmation),
    ).resolves.toEqual({ status: "STALE_STATE" });
    const prior = fixture({ prior: true });
    await expect(
      createJobParticipantRoleDecisionRepository(prior.sql).decide(
        confirmation,
      ),
    ).resolves.toEqual({ status: "STALE_STATE" });
  });

  it("deduplicates the same command and rejects changed payload", async () => {
    const applied = fixture();
    await createJobParticipantRoleDecisionRepository(applied.sql).decide(
      confirmation,
    );
    const insertAt = applied.statements.findIndex((statement) =>
      statement.includes("INSERT INTO"),
    );
    const fingerprint = applied.values[insertAt]?.at(-1);
    const existing = {
      decisionId: commandId,
      assignmentEventId,
      actorUserId,
      decision: "CONFIRM",
      reason: null,
      payloadFingerprint: fingerprint,
      decidedAt,
    };
    const retry = fixture({ existing, active: false });
    await expect(
      createJobParticipantRoleDecisionRepository(retry.sql).decide(
        confirmation,
      ),
    ).resolves.toEqual({
      status: "DEDUPLICATED",
      decisionId: commandId,
      decision: "CONFIRM",
      decidedAt,
    });
    const changed = fixture({ existing });
    await expect(
      createJobParticipantRoleDecisionRepository(changed.sql).decide({
        ...confirmation,
        decision: "REQUEST_CORRECTION",
        reason: "This was not my role",
      }),
    ).rejects.toThrow(JobParticipantRoleDecisionIdempotencyError);
  });
});
