import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobMainReviewRepository,
  JobMainReviewIdempotencyError,
  type JobMainReviewDirection,
} from "../src/job-main-review-repository.js";

const actorUserId = "91700000-0000-4000-8000-000000000001";
const otherUserId = "91700000-0000-4000-8000-000000000002";
const jobId = "91700000-0000-4000-8000-000000000003";
const targetProfileId = "91700000-0000-4000-8000-000000000004";
const commandId = "91700000-0000-4000-8000-000000000005";
const counterpartyRevisionId = "91700000-0000-4000-8000-000000000006";
const completedAt = new Date("2026-09-01T08:00:00.000Z");
const deadline = new Date("2026-09-15T08:00:00.000Z");
const submittedAt = new Date("2026-09-02T08:00:00.000Z");
const revisedAt = new Date("2026-09-02T08:20:00.000Z");
const nowAt = new Date("2026-09-02T08:30:00.000Z");

const customerRatings = Object.freeze({
  work_quality: 5 as const,
  price_adherence: 4 as const,
  schedule_adherence: null,
  communication: 5 as const,
  cleanliness: 4 as const,
  problem_solving: 5 as const,
  would_hire_again: 5 as const,
});

const providerRatings = Object.freeze({
  agreement_payment_experience: 4 as const,
  site_readiness: 3 as const,
  brief_clarity: 5 as const,
  communication: 4 as const,
  unplanned_changes: null,
  fairness: 5 as const,
});

interface FixtureOptions {
  readonly direction?: JobMainReviewDirection;
  readonly opportunity?: boolean;
  readonly existing?: Record<string, unknown>;
  readonly latestVersion?: number;
  readonly firstAt?: Date | null;
  readonly oppositeSubmitted?: boolean;
  readonly nowAt?: Date;
  readonly deadline?: Date;
  readonly opportunityRows?: readonly Record<string, unknown>[];
}

function fixture(options: FixtureOptions = {}) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const direction = options.direction ?? "CUSTOMER_TO_PROVIDER";
  const query = (
    parts: TemplateStringsArray,
    ...parameters: unknown[]
  ): Promise<readonly unknown[]> => {
    const statement = parts.join("?");
    statements.push(statement);
    values.push(parameters);
    if (statement.includes("SELECT opportunity.direction::text"))
      return Promise.resolve(
        options.opportunity === false
          ? []
          : [
              {
                direction,
                submissionDeadline: options.deadline ?? deadline,
              },
            ],
      );
    if (statement.includes("WHERE event_id = ?"))
      return Promise.resolve(
        options.existing === undefined ? [] : [options.existing],
      );
    if (statement.includes("coalesce(max(version), 0)::integer"))
      return Promise.resolve([
        {
          firstAt: options.firstAt ?? null,
          latestVersion: options.latestVersion ?? 0,
          oppositeSubmitted: options.oppositeSubmitted ?? false,
          nowAt: options.nowAt ?? nowAt,
        },
      ]);
    if (statement.includes("INSERT INTO job_main_review_events"))
      return Promise.resolve([{ recordedAt: nowAt }]);
    if (statement.includes("FROM job_main_review_opportunities opportunity"))
      return Promise.resolve(options.opportunityRows ?? []);
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

function opportunityRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jobId,
    direction: "CUSTOMER_TO_PROVIDER",
    targetProfileId,
    targetKind: "CRAFTSMAN_PROFILE",
    acceptedProfessionCode: "PROF:ELECTRICIAN",
    completedAt,
    submissionDeadline: deadline,
    deadlinePassed: false,
    ownRevisionId: null,
    ownVersion: null,
    ownSubmittedAt: null,
    ownRevisedAt: null,
    ownRatings: null,
    ownComment: null,
    ownUnlockedAt: null,
    counterpartyDirection: null,
    counterpartyRevisionId: null,
    counterpartySubmittedAt: null,
    counterpartyRevisedAt: null,
    counterpartyUnlockedAt: null,
    counterpartyRatings: null,
    counterpartyComment: null,
    ...overrides,
  };
}

const submit = {
  actorUserId,
  jobId,
  commandId,
  expectedVersion: 0,
  ratings: customerRatings,
  comment: "Spoľahlivo dokončená práca.",
};

describe("private main bilateral Job reviews", () => {
  it("rejects malformed identity, versions, ratings and comments before querying", async () => {
    for (const invalid of [
      { ...submit, commandId: "bad" },
      { ...submit, expectedVersion: -1 },
      { ...submit, ratings: [] },
      { ...submit, ratings: { ...customerRatings, surprise: 5 } },
      { ...submit, ratings: { ...customerRatings, work_quality: 6 } },
      { ...submit, comment: " padded " },
      { ...submit, comment: "unsafe\ncomment" },
      { ...submit, comment: "x".repeat(2001) },
    ]) {
      const fake = fixture();
      await expect(
        createJobMainReviewRepository(fake.sql).submit(invalid as never),
      ).rejects.toThrow(TypeError);
      expect(fake.statements).toEqual([]);
    }
    const fake = fixture();
    await expect(
      createJobMainReviewRepository(fake.sql).get({
        actorUserId,
        jobId: "bad",
      }),
    ).rejects.toThrow(TypeError);
    expect(fake.statements).toEqual([]);
  });

  it("lists only active verified actor opportunities and reads counterparty content only from the unlocked view", async () => {
    const fake = fixture({
      opportunityRows: [
        opportunityRow({
          ownRevisionId: commandId,
          ownVersion: 1,
          ownSubmittedAt: submittedAt,
          ownRevisedAt: submittedAt,
          ownRatings: customerRatings,
          ownComment: "Moje zatiaľ zapečatené hodnotenie.",
        }),
      ],
    });
    await expect(
      createJobMainReviewRepository(fake.sql).listForActor({ actorUserId }),
    ).resolves.toEqual([
      {
        jobId,
        direction: "CUSTOMER_TO_PROVIDER",
        targetProfileId,
        targetKind: "CRAFTSMAN_PROFILE",
        acceptedProfessionCode: "PROF:ELECTRICIAN",
        completedAt,
        submissionDeadline: deadline,
        state: "SUBMITTED_SEALED",
        ownReview: {
          revisionId: commandId,
          version: 1,
          submittedAt,
          revisedAt: submittedAt,
          ratings: customerRatings,
          comment: "Moje zatiaľ zapečatené hodnotenie.",
        },
        counterpartyReview: null,
      },
    ]);
    const statement = fake.statements[0] ?? "";
    expect(statement).toContain(
      "actor.id = ? AND actor.account_state = 'ACTIVE'",
    );
    expect(statement).toContain("credential.email_verified_at IS NOT NULL");
    expect(statement).toContain("credential.phone_verified_at IS NOT NULL");
    expect(statement).toContain(
      "event.actor_user_id = opportunity.author_user_id",
    );
    expect(statement).toContain(
      "LEFT JOIN current_unlocked_job_main_reviews counterparty",
    );
    expect(statement).not.toContain("counterparty_event.ratings");
  });

  it("returns unlocked counterparty content and the actor's latest own revision", async () => {
    const fake = fixture({
      opportunityRows: [
        opportunityRow({
          ownRevisionId: commandId,
          ownVersion: 2,
          ownSubmittedAt: submittedAt,
          ownRevisedAt: revisedAt,
          ownRatings: customerRatings,
          ownComment: "Upravené vlastné hodnotenie.",
          ownUnlockedAt: revisedAt,
          counterpartyDirection: "PROVIDER_TO_CUSTOMER",
          counterpartyRevisionId,
          counterpartySubmittedAt: revisedAt,
          counterpartyRevisedAt: revisedAt,
          counterpartyUnlockedAt: revisedAt,
          counterpartyRatings: providerRatings,
          counterpartyComment: "Férový zákazník.",
        }),
      ],
    });
    await expect(
      createJobMainReviewRepository(fake.sql).get({ actorUserId, jobId }),
    ).resolves.toMatchObject({
      state: "UNLOCKED",
      ownReview: { version: 2, comment: "Upravené vlastné hodnotenie." },
      counterpartyReview: {
        direction: "PROVIDER_TO_CUSTOMER",
        revisionId: counterpartyRevisionId,
        ratings: providerRatings,
        comment: "Férový zákazník.",
      },
    });
  });

  it("returns null/empty without leaking whether another actor has an opportunity", async () => {
    const one = fixture();
    await expect(
      createJobMainReviewRepository(one.sql).get({ actorUserId, jobId }),
    ).resolves.toBeNull();
    const many = fixture();
    await expect(
      createJobMainReviewRepository(many.sql).listForActor({ actorUserId }),
    ).resolves.toEqual([]);
  });

  it("fails closed on impossible sealed/unlocked or directional read provenance", async () => {
    for (const invalid of [
      opportunityRow({
        counterpartyDirection: "PROVIDER_TO_CUSTOMER",
        counterpartyRevisionId,
        counterpartySubmittedAt: revisedAt,
        counterpartyRevisedAt: revisedAt,
        counterpartyUnlockedAt: null,
        counterpartyRatings: providerRatings,
      }),
      opportunityRow({ targetKind: "CUSTOMER_PROFILE" }),
      opportunityRow({ acceptedProfessionCode: "UNVERIFIED" }),
    ]) {
      const fake = fixture({ opportunityRows: [invalid] });
      await expect(
        createJobMainReviewRepository(fake.sql).get({ actorUserId, jobId }),
      ).rejects.toThrow("Invalid Job main review opportunity provenance");
    }
  });

  it("derives direction, serializes on the Job and inserts the next append-only revision", async () => {
    const fake = fixture();
    await expect(
      createJobMainReviewRepository(fake.sql).submit(submit),
    ).resolves.toEqual({
      status: "APPLIED",
      direction: "CUSTOMER_TO_PROVIDER",
      revisionId: commandId,
      version: 1,
      recordedAt: nowAt,
    });
    const all = fake.statements.join("\n");
    expect(all).toContain("pg_advisory_xact_lock");
    expect(all).toContain("SELECT id FROM jobs WHERE id = ? FOR UPDATE");
    expect(all).toContain("INSERT INTO job_main_review_events");
    expect(all).toContain("?::job_main_review_direction");
    expect(all).not.toContain("direction = input");
    const insertAt = fake.statements.findIndex((statement) =>
      statement.includes("INSERT INTO job_main_review_events"),
    );
    expect(fake.values[insertAt]).toEqual([
      commandId,
      jobId,
      "CUSTOMER_TO_PROVIDER",
      1,
      actorUserId,
      customerRatings,
      "Spoľahlivo dokončená práca.",
    ]);
  });

  it("accepts only the exact dimension set derived for the actor's direction", async () => {
    const wrongCustomer = fixture();
    await expect(
      createJobMainReviewRepository(wrongCustomer.sql).submit({
        ...submit,
        ratings: providerRatings,
      }),
    ).rejects.toThrow("Exact substantive directional ratings");
    expect(wrongCustomer.statements.join("\n")).not.toContain(
      "INSERT INTO job_main_review_events",
    );

    const allNa = fixture();
    await expect(
      createJobMainReviewRepository(allNa.sql).submit({
        ...submit,
        ratings: Object.fromEntries(
          Object.keys(customerRatings).map((key) => [key, null]),
        ),
      }),
    ).rejects.toThrow("Exact substantive directional ratings");

    const provider = fixture({ direction: "PROVIDER_TO_CUSTOMER" });
    await expect(
      createJobMainReviewRepository(provider.sql).submit({
        ...submit,
        ratings: providerRatings,
      }),
    ).resolves.toMatchObject({
      status: "APPLIED",
      direction: "PROVIDER_TO_CUSTOMER",
    });
  });

  it("requires an active verified actor-scoped opportunity", async () => {
    const fake = fixture({ opportunity: false });
    await expect(
      createJobMainReviewRepository(fake.sql).submit(submit),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(fake.statements.join("\n")).toContain(
      "credential.phone_verified_at IS NOT NULL",
    );
    expect(fake.statements.join("\n")).not.toContain(
      "FROM job_main_review_events WHERE event_id",
    );
    expect(fake.statements.join("\n")).not.toContain(
      "INSERT INTO job_main_review_events",
    );
  });

  it("deduplicates an identical command before window/state checks", async () => {
    const fake = fixture({
      deadline: new Date("2026-09-01T09:00:00.000Z"),
      existing: {
        jobId,
        direction: "CUSTOMER_TO_PROVIDER",
        version: 1,
        actorUserId,
        ratings: { ...customerRatings },
        comment: "Spoľahlivo dokončená práca.",
        recordedAt: submittedAt,
      },
    });
    await expect(
      createJobMainReviewRepository(fake.sql).submit(submit),
    ).resolves.toEqual({
      status: "DEDUPLICATED",
      direction: "CUSTOMER_TO_PROVIDER",
      revisionId: commandId,
      version: 1,
      recordedAt: submittedAt,
    });
    expect(fake.statements.join("\n")).not.toContain(
      "coalesce(max(version), 0)",
    );
  });

  it("rejects changed command reuse and hides another actor's command", async () => {
    const changed = fixture({
      existing: {
        jobId,
        direction: "CUSTOMER_TO_PROVIDER",
        version: 1,
        actorUserId,
        ratings: customerRatings,
        comment: "Different comment",
        recordedAt: submittedAt,
      },
    });
    await expect(
      createJobMainReviewRepository(changed.sql).submit(submit),
    ).rejects.toThrow(JobMainReviewIdempotencyError);

    const hidden = fixture({
      existing: {
        jobId,
        direction: "CUSTOMER_TO_PROVIDER",
        version: 1,
        actorUserId: otherUserId,
        ratings: customerRatings,
        comment: "Spoľahlivo dokončená práca.",
        recordedAt: submittedAt,
      },
    });
    await expect(
      createJobMainReviewRepository(hidden.sql).submit(submit),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });

  it("returns explicit stale, deadline and edit-lock outcomes without inserting", async () => {
    const cases: readonly [FixtureOptions, string][] = [
      [{ latestVersion: 1 }, "STALE_VERSION"],
      [{ nowAt: deadline }, "WINDOW_CLOSED"],
      [
        {
          latestVersion: 1,
          firstAt: submittedAt,
          oppositeSubmitted: true,
        },
        "EDIT_LOCKED",
      ],
      [
        {
          latestVersion: 1,
          firstAt: submittedAt,
          nowAt: new Date(submittedAt.getTime() + 60 * 60 * 1000),
        },
        "EDIT_LOCKED",
      ],
    ];
    for (const [options, expected] of cases) {
      const fake = fixture(options);
      const expectedVersion = options.latestVersion ?? 0;
      await expect(
        createJobMainReviewRepository(fake.sql).submit({
          ...submit,
          expectedVersion: expected === "STALE_VERSION" ? 0 : expectedVersion,
        }),
      ).resolves.toEqual({ status: expected });
      expect(fake.statements.join("\n")).not.toContain(
        "INSERT INTO job_main_review_events",
      );
    }
  });
});
