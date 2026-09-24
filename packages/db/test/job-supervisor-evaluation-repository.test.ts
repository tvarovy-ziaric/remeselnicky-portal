import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobSupervisorEvaluationRepository,
  JobSupervisorEvaluationIdempotencyError,
} from "../src/job-supervisor-evaluation-repository.js";

const evaluatorId = "91900000-0000-4000-8000-000000000001";
const otherId = "91900000-0000-4000-8000-000000000002";
const jobId = "91900000-0000-4000-8000-000000000003";
const participantId = "91900000-0000-4000-8000-000000000004";
const profileId = "91900000-0000-4000-8000-000000000005";
const commandId = "91900000-0000-4000-8000-000000000006";
const completionDecisionId = "91900000-0000-4000-8000-000000000007";
const completedAt = new Date("2026-09-01T08:00:00.000Z");
const submissionDeadline = new Date("2026-09-15T08:00:00.000Z");
const overlapStartedAt = new Date("2026-08-20T08:00:00.000Z");
const overlapEndedAt = new Date("2026-09-01T08:00:00.000Z");
const submittedAt = new Date("2026-09-02T08:00:00.000Z");
const revisedAt = new Date("2026-09-02T08:20:00.000Z");
const editDeadline = new Date("2026-09-02T09:00:00.000Z");
const nowAt = new Date("2026-09-02T08:30:00.000Z");

const ratings = Object.freeze({
  competence_quality: 5 as const,
  reliability: 4 as const,
  independence: null,
  productivity: 4 as const,
  collaboration: 5 as const,
  problem_solving: 5 as const,
  would_take_into_crew_again: 5 as const,
});

interface FixtureOptions {
  readonly scope?: false | Record<string, unknown>;
  readonly targets?: readonly Record<string, unknown>[];
  readonly details?: readonly Record<string, unknown>[];
  readonly jobExists?: boolean;
  readonly opportunity?: false | Record<string, unknown>;
  readonly existing?: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
  readonly insertedAt?: Date | null;
}

function fixture(options: FixtureOptions = {}) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const query = (
    parts: TemplateStringsArray,
    ...parameters: unknown[]
  ): Promise<readonly unknown[]> => {
    const statement = parts.join("?");
    statements.push(statement);
    values.push(parameters);
    if (statement.includes("SELECT min(opportunity.completed_at)"))
      return Promise.resolve(
        options.scope === false
          ? []
          : [options.scope ?? { completedAt, submissionDeadline }],
      );
    if (
      statement.includes(
        'SELECT opportunity.target_participant_id AS "targetParticipantId"',
      )
    )
      return Promise.resolve(options.targets ?? []);
    if (
      statement.includes('SELECT evaluation.evaluation_id AS "evaluationId"') &&
      statement.includes('evaluator.nickname AS "evaluatorNickname"')
    )
      return Promise.resolve(options.details ?? []);
    if (statement.includes("SELECT id FROM jobs WHERE id = ? FOR UPDATE"))
      return Promise.resolve(
        options.jobExists === false ? [] : [{ id: jobId }],
      );
    if (statement.includes('clock_timestamp() AS "nowAt"'))
      return Promise.resolve(
        options.opportunity === false
          ? []
          : [options.opportunity ?? opportunityRow()],
      );
    if (statement.includes("WHERE revision.event_id = ?"))
      return Promise.resolve(
        options.existing === undefined ? [] : [options.existing],
      );
    if (statement.includes('max(revision.version)::integer AS "latestVersion"'))
      return Promise.resolve(
        options.state === undefined ? [] : [options.state],
      );
    if (statement.includes("INSERT INTO job_supervisor_evaluation_revisions"))
      return Promise.resolve(
        options.insertedAt === null
          ? []
          : [{ recordedAt: options.insertedAt ?? nowAt }],
      );
    return Promise.resolve([]);
  };
  const tx = Object.assign(query, {
    json: (value: unknown) => value,
  }) as unknown as TransactionSql;
  const sql = Object.assign(query, {
    json: (value: unknown) => value,
    begin: async <T>(callback: (transaction: TransactionSql) => Promise<T>) =>
      callback(tx),
  }) as unknown as Sql;
  return { sql, statements, values };
}

function opportunityRow(overrides: Record<string, unknown> = {}) {
  return {
    targetProfileId: profileId,
    relationshipKind: "PRIMARY_CONTRACTOR",
    evaluatorParticipantId: null,
    evaluatorRoleAssignmentEventId: null,
    sharedWorkGroupId: null,
    overlapStartedAt,
    overlapEndedAt,
    completionDecisionId,
    completedAt,
    submissionDeadline,
    nowAt,
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    targetParticipantId: participantId,
    targetProfileId: profileId,
    nickname: "Majster Ján",
    realFirstName: "Ján",
    realLastName: "Novák",
    relationshipKind: "PRIMARY_CONTRACTOR",
    overlapStartedAt,
    overlapEndedAt,
    verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
    verifiedRoles: ["MEMBER"],
    evaluationId: null,
    revisionId: null,
    version: null,
    submittedAt: null,
    revisedAt: null,
    editDeadline: null,
    ratings: null,
    comment: null,
    ...overrides,
  };
}

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    evaluationId: commandId,
    jobId,
    targetParticipantId: participantId,
    targetProfileId: profileId,
    evaluatorNickname: null,
    evaluatorFirstName: "Peter",
    evaluatorLastName: "Majster",
    evaluatorCompanyName: null,
    relationshipKind: "PRIMARY_CONTRACTOR",
    overlapStartedAt,
    overlapEndedAt,
    verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
    verifiedRoles: ["MEMBER"],
    revisionId: commandId,
    version: 1,
    submittedAt,
    revisedAt,
    editDeadline,
    ratings,
    comment: "Technicky kvalitná práca.",
    ...overrides,
  };
}

function submitInput() {
  return {
    actorUserId: evaluatorId,
    commandId,
    expectedVersion: 0,
    jobId,
    targetParticipantId: participantId,
    ratings,
    comment: "Technicky kvalitná práca.",
  } as const;
}

describe("Job supervisor evaluation repository", () => {
  it("returns the server-derived concise eligible target list", async () => {
    const fake = fixture({
      targets: [
        targetRow({
          evaluationId: commandId,
          revisionId: commandId,
          version: 1,
          submittedAt,
          revisedAt,
          editDeadline,
          ratings,
          comment: "Technicky kvalitná práca.",
        }),
      ],
    });
    await expect(
      createJobSupervisorEvaluationRepository(fake.sql).getForEvaluator({
        actorUserId: evaluatorId,
        jobId,
      }),
    ).resolves.toEqual({
      jobId,
      completedAt,
      submissionDeadline,
      targets: [
        {
          targetParticipantId: participantId,
          targetProfileId: profileId,
          displayName: "Majster Ján",
          relationshipKind: "PRIMARY_CONTRACTOR",
          overlapStartedAt,
          overlapEndedAt,
          verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
          verifiedRoles: ["MEMBER"],
          evaluation: {
            evaluationId: commandId,
            revisionId: commandId,
            version: 1,
            submittedAt,
            revisedAt,
            editDeadline,
            ratings,
            comment: "Technicky kvalitná práca.",
          },
        },
      ],
    });
    const all = fake.statements.join("\n");
    expect(all).toContain("opportunity.evaluator_user_id = ?");
    expect(all).toContain("actor.account_state = 'ACTIVE'");
    expect(all).toContain("verified_completed_job_capabilities");
    expect(all).toContain("verified_completed_job_roles");
  });

  it("returns null outside an exact evaluator opportunity", async () => {
    const fake = fixture({ scope: false });
    await expect(
      createJobSupervisorEvaluationRepository(fake.sql).getForEvaluator({
        actorUserId: evaluatorId,
        jobId,
      }),
    ).resolves.toBeNull();
    expect(fake.statements).toHaveLength(1);
  });

  it("returns raw content to the target with a privacy-safe evaluator display name", async () => {
    const fake = fixture({
      details: [detailRow({ evaluatorCompanyName: "Domstav s.r.o." })],
    });
    await expect(
      createJobSupervisorEvaluationRepository(fake.sql).getReceivedForTarget({
        actorUserId: otherId,
        jobId,
      }),
    ).resolves.toMatchObject({
      jobId,
      evaluations: [
        { evaluationId: commandId, evaluatorDisplayName: "Domstav s.r.o." },
      ],
    });
    const statement = fake.statements.join("\n");
    expect(statement).toContain("target.owner_user_id = viewer.id");
    expect(statement).not.toContain("viewer.email");
  });

  it("authorizes exact detail to evaluator or target in SQL", async () => {
    const fake = fixture({ details: [detailRow()] });
    await expect(
      createJobSupervisorEvaluationRepository(fake.sql).getById({
        actorUserId: evaluatorId,
        jobId,
        evaluationId: commandId,
      }),
    ).resolves.toMatchObject({
      evaluationId: commandId,
      evaluatorDisplayName: "Peter Majster",
    });
    expect(fake.statements.join("\n")).toContain(
      "evaluation.evaluator_user_id = viewer.id",
    );
  });

  it("rejects malformed identifiers, versions, dimensions, values and comments before querying", async () => {
    const valid = submitInput();
    for (const invalid of [
      { ...valid, actorUserId: "bad" },
      { ...valid, expectedVersion: -1 },
      { ...valid, ratings: [] },
      { ...valid, ratings: { ...ratings, surprise: 5 } },
      { ...valid, ratings: { ...ratings, reliability: 0 } },
      {
        ...valid,
        ratings: Object.fromEntries(
          Object.keys(ratings).map((key) => [key, null]),
        ),
      },
      { ...valid, comment: " padded " },
      { ...valid, comment: "unsafe\ncomment" },
      { ...valid, comment: "x".repeat(2_001) },
    ]) {
      const fake = fixture();
      await expect(
        createJobSupervisorEvaluationRepository(fake.sql).submit(
          invalid as never,
        ),
      ).rejects.toThrow(TypeError);
      expect(fake.statements).toEqual([]);
    }
  });

  it("creates a Job-locked append-only evaluation and revision", async () => {
    const fake = fixture();
    await expect(
      createJobSupervisorEvaluationRepository(fake.sql).submit(submitInput()),
    ).resolves.toEqual({
      status: "APPLIED",
      evaluationId: commandId,
      revisionId: commandId,
      version: 1,
      recordedAt: nowAt,
    });
    const all = fake.statements.join("\n");
    expect(all).toContain("pg_advisory_xact_lock");
    expect(all).toContain("SELECT id FROM jobs WHERE id = ? FOR UPDATE");
    expect(all).toContain("INSERT INTO job_supervisor_evaluations");
    expect(all).toContain("INSERT INTO job_supervisor_evaluation_revisions");
    expect(all).toContain("credential.phone_verified_at IS NOT NULL");
  });

  it("edits the existing logical evaluation without another header", async () => {
    const evaluationId = "91900000-0000-4000-8000-000000000008";
    const fake = fixture({
      state: { evaluationId, latestVersion: 1, firstAt: submittedAt },
    });
    await expect(
      createJobSupervisorEvaluationRepository(fake.sql).submit({
        ...submitInput(),
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ status: "APPLIED", evaluationId, version: 2 });
    expect(
      fake.statements.filter((statement) =>
        statement.includes("INSERT INTO job_supervisor_evaluations ("),
      ),
    ).toEqual([]);
  });

  it("deduplicates exact retries and rejects changed command reuse", async () => {
    const existing = {
      evaluatorUserId: evaluatorId,
      evaluationId: commandId,
      jobId,
      targetParticipantId: participantId,
      version: 1,
      ratings,
      comment: "Technicky kvalitná práca.",
      recordedAt: submittedAt,
    };
    const same = fixture({ existing });
    await expect(
      createJobSupervisorEvaluationRepository(same.sql).submit(submitInput()),
    ).resolves.toMatchObject({
      status: "DEDUPLICATED",
      evaluationId: commandId,
    });

    const changed = fixture({
      existing: { ...existing, comment: "Iný zámer." },
    });
    await expect(
      createJobSupervisorEvaluationRepository(changed.sql).submit(
        submitInput(),
      ),
    ).rejects.toThrow(JobSupervisorEvaluationIdempotencyError);
  });

  it("returns explicit missing, stale, deadline and edit-lock outcomes without writes", async () => {
    const cases = [
      {
        options: { jobExists: false },
        input: submitInput(),
        status: "NOT_FOUND",
      },
      {
        options: { opportunity: false },
        input: submitInput(),
        status: "NOT_FOUND",
      },
      {
        options: {
          state: {
            evaluationId: commandId,
            latestVersion: 1,
            firstAt: submittedAt,
          },
        },
        input: submitInput(),
        status: "STALE_VERSION",
      },
      {
        options: { opportunity: opportunityRow({ nowAt: submissionDeadline }) },
        input: submitInput(),
        status: "WINDOW_CLOSED",
      },
      {
        options: {
          opportunity: opportunityRow({ nowAt: editDeadline }),
          state: {
            evaluationId: commandId,
            latestVersion: 1,
            firstAt: submittedAt,
          },
        },
        input: { ...submitInput(), expectedVersion: 1 },
        status: "EDIT_LOCKED",
      },
    ] as const;
    for (const item of cases) {
      const fake = fixture(item.options);
      await expect(
        createJobSupervisorEvaluationRepository(fake.sql).submit(item.input),
      ).resolves.toEqual({ status: item.status });
      expect(fake.statements.join("\n")).not.toContain(
        "INSERT INTO job_supervisor_evaluation_revisions",
      );
    }
  });
});
