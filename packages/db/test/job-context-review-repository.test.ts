import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobContextReviewRepository,
  JobContextReviewIdempotencyError,
  type JobContextReviewTargetKind,
} from "../src/job-context-review-repository.js";

const actorUserId = "91800000-0000-4000-8000-000000000001";
const otherUserId = "91800000-0000-4000-8000-000000000002";
const jobId = "91800000-0000-4000-8000-000000000003";
const participantId = "91800000-0000-4000-8000-000000000004";
const participantProfileId = "91800000-0000-4000-8000-000000000005";
const workGroupId = "91800000-0000-4000-8000-000000000006";
const assignmentId = "91800000-0000-4000-8000-000000000007";
const commandId = "91800000-0000-4000-8000-000000000008";
const completionDecisionId = "91800000-0000-4000-8000-000000000010";
const completedAt = new Date("2026-09-01T08:00:00.000Z");
const submissionDeadline = new Date("2026-09-15T08:00:00.000Z");
const participationStartedAt = new Date("2026-08-20T07:00:00.000Z");
const participationEndedAt = new Date("2026-09-01T07:00:00.000Z");
const submittedAt = new Date("2026-09-02T08:00:00.000Z");
const revisedAt = new Date("2026-09-02T08:20:00.000Z");
const editDeadline = new Date("2026-09-02T09:00:00.000Z");
const nowAt = new Date("2026-09-02T08:30:00.000Z");

const participantRatings = Object.freeze({
  work_quality: 5 as const,
  price_adherence: 4 as const,
  schedule_adherence: null,
  communication: 5 as const,
  cleanliness: 4 as const,
  problem_solving: 5 as const,
  would_hire_again: 5 as const,
});

const workGroupRatings = Object.freeze({
  result_quality: 5 as const,
  coordination: 4 as const,
  timing: null,
  communication: 5 as const,
  cleanliness: 4 as const,
  problem_solving: 5 as const,
});

interface FixtureOptions {
  readonly scope?: false | Record<string, unknown>;
  readonly participantRows?: readonly Record<string, unknown>[];
  readonly workGroupRows?: readonly Record<string, unknown>[];
  readonly memberRows?: readonly Record<string, unknown>[];
  readonly jobExists?: boolean;
  readonly opportunity?: false | Record<string, unknown>;
  readonly existing?: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
  readonly revisionRecordedAt?: Date | null;
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
          : [
              options.scope ?? {
                completedAt,
                submissionDeadline,
              },
            ],
      );
    if (
      statement.includes(
        'SELECT opportunity.participant_id AS "participantId"',
      ) &&
      !statement.includes("clock_timestamp()")
    )
      return Promise.resolve(options.participantRows ?? []);
    if (statement.includes('SELECT opportunity.work_group_id AS "workGroupId"'))
      return Promise.resolve(options.workGroupRows ?? []);
    if (statement.includes('SELECT assignment.work_group_id AS "workGroupId"'))
      return Promise.resolve(options.memberRows ?? []);
    if (statement.includes("SELECT id FROM jobs WHERE id = ? FOR UPDATE"))
      return Promise.resolve(
        options.jobExists === false ? [] : [{ id: jobId }],
      );
    if (statement.includes("clock_timestamp()"))
      return Promise.resolve(
        options.opportunity === false
          ? []
          : [
              options.opportunity ?? {
                participantId,
                workGroupId: null,
                completionDecisionId,
                completedAt,
                submissionDeadline,
                nowAt,
              },
            ],
      );
    if (statement.includes("WHERE revision.event_id = ?"))
      return Promise.resolve(
        options.existing === undefined ? [] : [options.existing],
      );
    if (statement.includes('SELECT review.review_id AS "reviewId"'))
      return Promise.resolve(
        options.state === undefined ? [] : [options.state],
      );
    if (statement.includes("INSERT INTO job_context_review_revisions"))
      return Promise.resolve(
        options.revisionRecordedAt === null
          ? []
          : [{ recordedAt: options.revisionRecordedAt ?? nowAt }],
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

function participantRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    participantId,
    participantProfileId,
    nickname: "Majster Ján",
    realFirstName: "Ján",
    realLastName: "Novák",
    participationStartedAt,
    participationEndedAt,
    verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
    verifiedRoles: ["MEMBER", "LEAD"],
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

function workGroupRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workGroupId,
    name: "Elektro tím",
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

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    workGroupId,
    assignmentId,
    participantId,
    participantProfileId,
    nickname: null,
    realFirstName: "Ján",
    realLastName: "Novák",
    overlapStartedAt: participationStartedAt,
    overlapEndedAt: participationEndedAt,
    ...overrides,
  };
}

function submitInput(targetKind: JobContextReviewTargetKind = "PARTICIPANT") {
  return {
    actorUserId,
    jobId,
    targetKind,
    targetId: targetKind === "PARTICIPANT" ? participantId : workGroupId,
    commandId,
    expectedVersion: 0,
    ratings:
      targetKind === "PARTICIPANT" ? participantRatings : workGroupRatings,
    comment: "Spoľahlivo odvedená práca.",
  } as const;
}

describe("customer participant and historical work-group Job reviews", () => {
  it("projects exact verified participant and historical work-group targets for the active verified customer", async () => {
    const fake = fixture({
      participantRows: [
        participantRow({
          revisionId: commandId,
          version: 2,
          submittedAt,
          revisedAt,
          editDeadline,
          ratings: participantRatings,
          comment: "Upravené hodnotenie remeselníka.",
        }),
      ],
      workGroupRows: [workGroupRow()],
      memberRows: [memberRow()],
    });

    await expect(
      createJobContextReviewRepository(fake.sql).getForCustomer({
        actorUserId,
        jobId,
      }),
    ).resolves.toEqual({
      jobId,
      completedAt,
      submissionDeadline,
      participants: [
        {
          targetKind: "PARTICIPANT",
          participantId,
          participantProfileId,
          displayName: "Majster Ján",
          participationStartedAt,
          participationEndedAt,
          verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
          verifiedRoles: ["MEMBER", "LEAD"],
          review: {
            revisionId: commandId,
            version: 2,
            submittedAt,
            revisedAt,
            editDeadline,
            ratings: participantRatings,
            comment: "Upravené hodnotenie remeselníka.",
          },
        },
      ],
      workGroups: [
        {
          targetKind: "WORK_GROUP",
          workGroupId,
          name: "Elektro tím",
          members: [
            {
              assignmentId,
              participantId,
              participantProfileId,
              displayName: "Ján Novák",
              overlapStartedAt: participationStartedAt,
              overlapEndedAt: participationEndedAt,
            },
          ],
          review: null,
        },
      ],
    });

    const all = fake.statements.join("\n");
    expect(all).toContain("actor.id = ?");
    expect(all).toContain("actor.account_state = 'ACTIVE'");
    expect(all).toContain("credential.email_verified_at IS NOT NULL");
    expect(all).toContain("credential.phone_verified_at IS NOT NULL");
    expect(all).toContain("verified_individual_completed_job_participation");
    expect(all).toContain("verified_completed_job_capabilities");
    expect(all).toContain("verified_completed_job_roles");
    expect(all).toContain("verified_completed_job_work_group_assignments");
    expect(all).toContain("current_job_context_reviews");
    expect(all).not.toContain("crew_id");
  });

  it("returns null without leaking targets outside the customer's opportunity scope", async () => {
    const fake = fixture({ scope: false });
    await expect(
      createJobContextReviewRepository(fake.sql).getForCustomer({
        actorUserId,
        jobId,
      }),
    ).resolves.toBeNull();
    expect(fake.statements).toHaveLength(1);
  });

  it("does not query a roster when there are no eligible historical work groups", async () => {
    const fake = fixture({ participantRows: [participantRow()] });
    await expect(
      createJobContextReviewRepository(fake.sql).getForCustomer({
        actorUserId,
        jobId,
      }),
    ).resolves.toMatchObject({
      participants: [{ participantId }],
      workGroups: [],
    });
    expect(fake.statements.join("\n")).not.toContain(
      "verified_completed_job_work_group_assignments assignment",
    );
  });

  it("fails closed on malformed scope, participant, group, roster and review provenance", async () => {
    const cases: readonly FixtureOptions[] = [
      { scope: { completedAt, submissionDeadline: completedAt } },
      { participantRows: [participantRow({ verifiedRoles: ["LEAD"] })] },
      {
        participantRows: [
          participantRow({ verifiedProfessionCodes: ["NOT_VERIFIED"] }),
        ],
      },
      {
        workGroupRows: [workGroupRow({ name: " padded " })],
        memberRows: [memberRow()],
      },
      { workGroupRows: [workGroupRow()], memberRows: [] },
      {
        workGroupRows: [workGroupRow()],
        memberRows: [memberRow({ workGroupId: participantId })],
      },
      {
        participantRows: [
          participantRow({
            revisionId: commandId,
            version: 1,
            submittedAt,
            revisedAt: new Date(submittedAt.getTime() - 1),
            editDeadline,
            ratings: participantRatings,
          }),
        ],
      },
      {
        participantRows: [
          participantRow({ revisionId: commandId, version: 1 }),
        ],
      },
    ];
    for (const options of cases) {
      const fake = fixture(options);
      await expect(
        createJobContextReviewRepository(fake.sql).getForCustomer({
          actorUserId,
          jobId,
        }),
      ).rejects.toThrow(/provenance|roster/i);
    }
  });

  it("rejects malformed identities, targets, versions, ratings and comments before querying", async () => {
    const valid = submitInput();
    for (const invalid of [
      { ...valid, actorUserId: "bad" },
      { ...valid, targetKind: "CREW" },
      { ...valid, expectedVersion: -1 },
      { ...valid, ratings: [] },
      { ...valid, ratings: { ...participantRatings, surprise: 5 } },
      { ...valid, ratings: { ...participantRatings, work_quality: 0 } },
      {
        ...valid,
        ratings: Object.fromEntries(
          Object.keys(participantRatings).map((key) => [key, null]),
        ),
      },
      { ...valid, ratings: workGroupRatings },
      { ...valid, comment: " padded " },
      { ...valid, comment: "unsafe\ncomment" },
      { ...valid, comment: "x".repeat(2_001) },
    ]) {
      const fake = fixture();
      await expect(
        createJobContextReviewRepository(fake.sql).submit(invalid as never),
      ).rejects.toThrow(TypeError);
      expect(fake.statements).toEqual([]);
    }

    const fake = fixture();
    await expect(
      createJobContextReviewRepository(fake.sql).getForCustomer({
        actorUserId,
        jobId: "bad",
      }),
    ).rejects.toThrow(TypeError);
    expect(fake.statements).toEqual([]);
  });

  it.each([
    ["PARTICIPANT", participantId, participantRatings],
    ["WORK_GROUP", workGroupId, workGroupRatings],
  ] as const)(
    "creates an append-only %s review for only the exact eligible target",
    async (targetKind, targetId, ratings) => {
      const fake = fixture({
        opportunity: {
          participantId: targetKind === "PARTICIPANT" ? participantId : null,
          workGroupId: targetKind === "WORK_GROUP" ? workGroupId : null,
          completionDecisionId,
          completedAt,
          submissionDeadline,
          nowAt,
        },
      });
      await expect(
        createJobContextReviewRepository(fake.sql).submit({
          ...submitInput(targetKind),
          ratings,
        }),
      ).resolves.toEqual({
        status: "APPLIED",
        targetKind,
        targetId,
        revisionId: commandId,
        version: 1,
        recordedAt: nowAt,
      });

      const all = fake.statements.join("\n");
      expect(all).toContain("pg_advisory_xact_lock");
      expect(all).toContain("SELECT id FROM jobs WHERE id = ? FOR UPDATE");
      expect(all).toContain(
        "opportunity.target_kind = ?::job_context_review_target_kind",
      );
      expect(all).toContain("opportunity.participant_id = ?");
      expect(all).toContain("opportunity.work_group_id = ?");
      expect(all).toContain("actor.account_state = 'ACTIVE'");
      expect(all).toContain("credential.phone_verified_at IS NOT NULL");
      expect(all).toContain("INSERT INTO job_context_reviews");
      expect(all).toContain("INSERT INTO job_context_review_revisions");
      expect(all).toContain("participant_profile_id");
      expect(all).toContain("completion_decision_id");
      const revisionAt = fake.statements.findIndex((statement) =>
        statement.includes("INSERT INTO job_context_review_revisions"),
      );
      expect(fake.values[revisionAt]).toEqual([
        commandId,
        commandId,
        1,
        actorUserId,
        ratings,
        "Spoľahlivo odvedená práca.",
      ]);
    },
  );

  it("edits an existing logical review without inserting another header", async () => {
    const fake = fixture({
      state: {
        reviewId: "91800000-0000-4000-8000-000000000009",
        latestVersion: 1,
        firstAt: submittedAt,
      },
    });
    await expect(
      createJobContextReviewRepository(fake.sql).submit({
        ...submitInput(),
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ status: "APPLIED", version: 2 });
    expect(
      fake.statements.filter((statement) =>
        statement.includes("INSERT INTO job_context_reviews ("),
      ),
    ).toEqual([]);
    const revisionAt = fake.statements.findIndex((statement) =>
      statement.includes("INSERT INTO job_context_review_revisions"),
    );
    expect(fake.values[revisionAt]?.[1]).toBe(
      "91800000-0000-4000-8000-000000000009",
    );
  });

  it("requires a locked Job and an active verified actor-scoped exact opportunity", async () => {
    const missingJob = fixture({ jobExists: false });
    await expect(
      createJobContextReviewRepository(missingJob.sql).submit(submitInput()),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(missingJob.statements.join("\n")).not.toContain("clock_timestamp()");

    const missingOpportunity = fixture({ opportunity: false });
    await expect(
      createJobContextReviewRepository(missingOpportunity.sql).submit(
        submitInput(),
      ),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(missingOpportunity.statements.join("\n")).not.toContain(
      "WHERE revision.event_id",
    );
    expect(missingOpportunity.statements.join("\n")).not.toContain(
      "INSERT INTO job_context_reviews",
    );
  });

  it("fails closed if the database returns mismatched or malformed opportunity provenance", async () => {
    for (const opportunity of [
      {
        participantId: otherUserId,
        workGroupId: null,
        completionDecisionId,
        completedAt,
        submissionDeadline,
        nowAt,
      },
      {
        participantId,
        workGroupId: null,
        completionDecisionId,
        completedAt: "not-a-date",
        submissionDeadline,
        nowAt,
      },
    ]) {
      const fake = fixture({ opportunity });
      await expect(
        createJobContextReviewRepository(fake.sql).submit(submitInput()),
      ).rejects.toThrow("Invalid Job context review opportunity provenance");
      expect(fake.statements.join("\n")).not.toContain(
        "INSERT INTO job_context_reviews",
      );
    }
  });

  it("deduplicates an identical command before version and time-window checks", async () => {
    const fake = fixture({
      opportunity: {
        participantId,
        workGroupId: null,
        completionDecisionId,
        completedAt,
        submissionDeadline: completedAt,
        nowAt: submissionDeadline,
      },
      existing: {
        actorUserId,
        jobId,
        targetKind: "PARTICIPANT",
        targetId: participantId,
        version: 1,
        ratings: { ...participantRatings },
        comment: "Spoľahlivo odvedená práca.",
        recordedAt: submittedAt,
      },
    });
    await expect(
      createJobContextReviewRepository(fake.sql).submit(submitInput()),
    ).resolves.toEqual({
      status: "DEDUPLICATED",
      targetKind: "PARTICIPANT",
      targetId: participantId,
      revisionId: commandId,
      version: 1,
      recordedAt: submittedAt,
    });
    expect(fake.statements.join("\n")).not.toContain(
      'SELECT review.review_id AS "reviewId"',
    );
  });

  it("rejects changed command reuse and hides another actor's command", async () => {
    const changed = fixture({
      existing: {
        actorUserId,
        jobId,
        targetKind: "PARTICIPANT",
        targetId: participantId,
        version: 1,
        ratings: participantRatings,
        comment: "Iný zámer.",
        recordedAt: submittedAt,
      },
    });
    await expect(
      createJobContextReviewRepository(changed.sql).submit(submitInput()),
    ).rejects.toThrow(JobContextReviewIdempotencyError);

    const hidden = fixture({
      existing: {
        actorUserId: otherUserId,
        jobId,
        targetKind: "PARTICIPANT",
        targetId: participantId,
        version: 1,
        ratings: participantRatings,
        comment: "Spoľahlivo odvedená práca.",
        recordedAt: submittedAt,
      },
    });
    await expect(
      createJobContextReviewRepository(hidden.sql).submit(submitInput()),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });

  it("returns explicit stale, submission-window and edit-lock outcomes without writing", async () => {
    const cases = [
      {
        options: {
          state: {
            reviewId: commandId,
            latestVersion: 1,
            firstAt: submittedAt,
          },
        },
        input: submitInput(),
        status: "STALE_VERSION",
      },
      {
        options: {
          opportunity: {
            participantId,
            workGroupId: null,
            completionDecisionId,
            completedAt,
            submissionDeadline,
            nowAt: submissionDeadline,
          },
        },
        input: submitInput(),
        status: "WINDOW_CLOSED",
      },
      {
        options: {
          opportunity: {
            participantId,
            workGroupId: null,
            completionDecisionId,
            completedAt,
            submissionDeadline,
            nowAt: editDeadline,
          },
          state: {
            reviewId: commandId,
            latestVersion: 1,
            firstAt: submittedAt,
          },
        },
        input: { ...submitInput(), expectedVersion: 1 },
        status: "EDIT_LOCKED",
      },
    ] as const;

    for (const testCase of cases) {
      const fake = fixture(testCase.options);
      await expect(
        createJobContextReviewRepository(fake.sql).submit(testCase.input),
      ).resolves.toEqual({ status: testCase.status });
      expect(fake.statements.join("\n")).not.toContain(
        "INSERT INTO job_context_review_revisions",
      );
    }
  });

  it("fails closed when an inserted append-only revision has no valid effect", async () => {
    const fake = fixture({ revisionRecordedAt: null });
    await expect(
      createJobContextReviewRepository(fake.sql).submit(submitInput()),
    ).rejects.toThrow("Job context review revision effect missing");
  });
});
