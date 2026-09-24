import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createReviewResponseReportRepository,
  ModerationReportIdempotencyError,
  ReviewResponseIdempotencyError,
} from "../src/review-response-report-repository.js";

const actorId = "92000000-0000-4000-8000-000000000001";
const reviewId = "92000000-0000-4000-8000-000000000002";
const commandId = "92000000-0000-4000-8000-000000000003";
const jobId = "92000000-0000-4000-8000-000000000004";
const responseId = "92000000-0000-4000-8000-000000000005";
const recordedAt = new Date("2026-09-24T10:00:00.000Z");
const lockedAt = new Date("2026-09-24T11:00:00.000Z");

interface Options {
  readonly ownerResponse?: false | Record<string, unknown>;
  readonly existingResponseEvent?: Record<string, unknown>;
  readonly reviewScope?: false | Record<string, unknown>;
  readonly jobExists?: boolean;
  readonly currentResponse?: Record<string, unknown>;
  readonly existingReport?: Record<string, unknown>;
  readonly reportable?: boolean;
  readonly duplicateReportId?: string;
  readonly insertedAt?: Date | null;
}

function fixture(options: Options = {}) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const query = (
    parts: TemplateStringsArray,
    ...parameters: unknown[]
  ): Promise<readonly unknown[]> => {
    const statement = parts.join("?");
    statements.push(statement);
    values.push(parameters);
    if (statement.includes(") AS reportable"))
      return Promise.resolve([{ reportable: options.reportable ?? true }]);
    if (
      statement.includes("FROM current_job_main_review_responses response") &&
      statement.includes("profile.owner_user_id = ?")
    )
      return Promise.resolve(
        options.ownerResponse === false
          ? []
          : [options.ownerResponse ?? responseRow()],
      );
    if (statement.includes("WHERE event.event_id = ?"))
      return Promise.resolve(
        options.existingResponseEvent === undefined
          ? []
          : [options.existingResponseEvent],
      );
    if (
      statement.includes("FROM current_unlocked_job_main_reviews review") &&
      statement.includes('clock_timestamp() AS "nowAt"')
    )
      return Promise.resolve(
        options.reviewScope === false
          ? []
          : [
              options.reviewScope ?? {
                authorUserId: actorId,
                direction: "CUSTOMER_TO_PROVIDER",
                jobId,
                nowAt: recordedAt,
              },
            ],
      );
    if (statement.includes("SELECT id FROM jobs WHERE id = ? FOR UPDATE"))
      return Promise.resolve(
        options.jobExists === false ? [] : [{ id: jobId }],
      );
    if (
      statement.includes("FROM current_job_main_review_responses response") &&
      !statement.includes("profile.owner_user_id = ?")
    )
      return Promise.resolve(
        options.currentResponse === undefined ? [] : [options.currentResponse],
      );
    if (statement.includes("FROM moderation_reports WHERE report_id = ?"))
      return Promise.resolve(
        options.existingReport === undefined ? [] : [options.existingReport],
      );
    if (
      statement.includes('SELECT report_id AS "reportId"') &&
      statement.includes("target_type = ?")
    )
      return Promise.resolve(
        options.duplicateReportId === undefined
          ? []
          : [{ reportId: options.duplicateReportId }],
      );
    if (
      statement.includes("RETURNING recorded_at") ||
      statement.includes("RETURNING reported_at")
    )
      return Promise.resolve(
        options.insertedAt === null
          ? []
          : [{ recordedAt: options.insertedAt ?? recordedAt }],
      );
    return Promise.resolve([]);
  };
  const tx = Object.assign(query, {}) as unknown as TransactionSql;
  const sql = Object.assign(query, {
    begin: async <T>(callback: (transaction: TransactionSql) => Promise<T>) =>
      callback(tx),
  }) as unknown as Sql;
  return { sql, statements, values };
}

function responseRow(overrides: Record<string, unknown> = {}) {
  return {
    responseId,
    reviewId,
    revisionId: commandId,
    version: 1,
    body: "Vecné stanovisko poskytovateľa.",
    respondedAt: recordedAt,
    revisedAt: recordedAt,
    lockedAt,
    ...overrides,
  };
}

function responseInput(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: actorId,
    commandId,
    expectedVersion: 0,
    reviewId,
    body: "Vecné stanovisko poskytovateľa.",
    ...overrides,
  };
}

function reportInput(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: actorId,
    commandId,
    targetType: "MAIN_REVIEW" as const,
    targetId: reviewId,
    reason: "IRRELEVANT_CONTENT" as const,
    details: "Komentár nesúvisí s vykonanou zákazkou.",
    ...overrides,
  };
}

describe("review response and report repository", () => {
  it("reads a response only through the exact active verified profile owner", async () => {
    const fake = fixture();
    await expect(
      createReviewResponseReportRepository(fake.sql).getResponseForOwner({
        actorUserId: actorId,
        reviewId,
      }),
    ).resolves.toEqual({
      responseId,
      reviewId,
      revisionId: commandId,
      version: 1,
      body: "Vecné stanovisko poskytovateľa.",
      respondedAt: recordedAt,
      revisedAt: recordedAt,
      editDeadline: lockedAt,
    });
    const query = fake.statements.join("\n");
    expect(query).toContain("profile.owner_user_id = ?");
    expect(query).toContain("actor.account_state = 'ACTIVE'");
    expect(query).toContain("credential.phone_verified_at IS NOT NULL");
  });

  it("rejects malformed response and report inputs before querying", async () => {
    for (const invalid of [
      responseInput({ actorUserId: "bad" }),
      responseInput({ expectedVersion: -1 }),
      responseInput({ body: " padded " }),
      responseInput({ body: "unsafe\nbody" }),
      responseInput({ body: "Kontakt +421 900 123 456" }),
      responseInput({ body: "x".repeat(2_001) }),
    ]) {
      const fake = fixture();
      await expect(
        createReviewResponseReportRepository(fake.sql).submitResponse(
          invalid as never,
        ),
      ).rejects.toThrow(TypeError);
      expect(fake.statements).toEqual([]);
    }
    for (const invalid of [
      reportInput({ targetType: "UNKNOWN" }),
      reportInput({ reason: "NEGATIVE_REVIEW" }),
      reportInput({ details: " padded " }),
      reportInput({ details: "x".repeat(1_001) }),
    ]) {
      const fake = fixture();
      await expect(
        createReviewResponseReportRepository(fake.sql).createReport(
          invalid as never,
        ),
      ).rejects.toThrow(TypeError);
      expect(fake.statements).toEqual([]);
    }
  });

  it("creates one Job-locked response header and first immutable revision", async () => {
    const fake = fixture();
    await expect(
      createReviewResponseReportRepository(fake.sql).submitResponse(
        responseInput(),
      ),
    ).resolves.toEqual({
      status: "APPLIED",
      responseId: commandId,
      revisionId: commandId,
      version: 1,
      recordedAt,
    });
    const all = fake.statements.join("\n");
    expect(all).toContain("pg_advisory_xact_lock");
    expect(all).toContain("SELECT id FROM jobs WHERE id = ? FOR UPDATE");
    expect(all).toContain("INSERT INTO job_main_review_responses");
    expect(all).toContain("INSERT INTO job_main_review_response_events");
  });

  it("edits only the response stream and returns stale or locked outcomes", async () => {
    const current = responseRow();
    const edit = fixture({ currentResponse: current });
    await expect(
      createReviewResponseReportRepository(edit.sql).submitResponse(
        responseInput({ expectedVersion: 1 }),
      ),
    ).resolves.toMatchObject({
      status: "APPLIED",
      responseId,
      version: 2,
    });
    expect(
      edit.statements.filter((statement) =>
        statement.includes("INSERT INTO job_main_review_responses ("),
      ),
    ).toEqual([]);

    const stale = fixture({ currentResponse: current });
    await expect(
      createReviewResponseReportRepository(stale.sql).submitResponse(
        responseInput(),
      ),
    ).resolves.toEqual({ status: "STALE_VERSION" });

    const locked = fixture({
      currentResponse: current,
      reviewScope: {
        authorUserId: actorId,
        direction: "CUSTOMER_TO_PROVIDER",
        jobId,
        nowAt: lockedAt,
      },
    });
    await expect(
      createReviewResponseReportRepository(locked.sql).submitResponse(
        responseInput({ expectedVersion: 1 }),
      ),
    ).resolves.toEqual({ status: "EDIT_LOCKED" });
  });

  it("deduplicates exact response retries and rejects changed intent", async () => {
    const existing = {
      actorUserId: actorId,
      responseId,
      reviewId,
      version: 1,
      body: "Vecné stanovisko poskytovateľa.",
      recordedAt,
    };
    await expect(
      createReviewResponseReportRepository(
        fixture({ existingResponseEvent: existing }).sql,
      ).submitResponse(responseInput()),
    ).resolves.toMatchObject({ status: "DEDUPLICATED", responseId });
    await expect(
      createReviewResponseReportRepository(
        fixture({
          existingResponseEvent: { ...existing, body: "Iný zámer." },
        }).sql,
      ).submitResponse(responseInput()),
    ).rejects.toThrow(ReviewResponseIdempotencyError);
  });

  it("creates an OPEN report without changing its target", async () => {
    const fake = fixture();
    await expect(
      createReviewResponseReportRepository(fake.sql).createReport(
        reportInput(),
      ),
    ).resolves.toEqual({
      status: "APPLIED",
      reportId: commandId,
      state: "OPEN",
      recordedAt,
    });
    const all = fake.statements.join("\n");
    expect(all).toContain("moderation_target_is_reportable");
    expect(all).toContain("INSERT INTO moderation_reports");
    expect(all).not.toContain("UPDATE job_main_review_events");
    expect(all).not.toContain("UPDATE users");
  });

  it("keeps report retries idempotent and each reporter-target pair single", async () => {
    const existing = {
      reportId: commandId,
      reporterUserId: actorId,
      targetType: "MAIN_REVIEW",
      targetId: reviewId,
      reason: "IRRELEVANT_CONTENT",
      details: "Komentár nesúvisí s vykonanou zákazkou.",
      evidenceReferenceType: null,
      evidenceReferenceId: null,
      reportedAt: recordedAt,
    };
    await expect(
      createReviewResponseReportRepository(
        fixture({ existingReport: existing }).sql,
      ).createReport(reportInput()),
    ).resolves.toMatchObject({ status: "DEDUPLICATED", state: "OPEN" });
    await expect(
      createReviewResponseReportRepository(
        fixture({ existingReport: { ...existing, reason: "OTHER" } }).sql,
      ).createReport(reportInput()),
    ).rejects.toThrow(ModerationReportIdempotencyError);
    await expect(
      createReviewResponseReportRepository(
        fixture({ duplicateReportId: responseId }).sql,
      ).createReport(reportInput()),
    ).resolves.toEqual({ status: "ALREADY_REPORTED" });
    await expect(
      createReviewResponseReportRepository(
        fixture({ reportable: false }).sql,
      ).createReport(reportInput()),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });
});
