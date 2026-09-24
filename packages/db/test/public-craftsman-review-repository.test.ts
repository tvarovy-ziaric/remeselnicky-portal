import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createPublicCraftsmanReviewRepository,
  PublicCraftsmanReviewProjectionError,
  PublicCraftsmanReviewQueryValidationError,
} from "../src/public-craftsman-review-repository.js";

const profileId = "94000000-0000-4000-8000-000000000001";
const review1 = "94000000-0000-4000-8000-000000000011";
const review2 = "94000000-0000-4000-8000-000000000012";
const review3 = "94000000-0000-4000-8000-000000000013";

describe("public craftsman review repository", () => {
  it("rejects malformed input before opening a database snapshot", async () => {
    for (const input of [
      { craftsmanProfileId: "not-a-profile" },
      { craftsmanProfileId: profileId, cursor: review1 },
      { craftsmanProfileId: profileId, cursor: "v2." + review1 },
      { craftsmanProfileId: profileId, limit: 0 },
      { craftsmanProfileId: profileId, limit: 21 },
      { craftsmanProfileId: profileId, limit: 1.5 },
    ]) {
      const sql = scriptedSql([]);
      await expect(repository(sql).list(input)).rejects.toBeInstanceOf(
        PublicCraftsmanReviewQueryValidationError,
      );
      expect(sql.beginOptions).toEqual([]);
      expect(sql.queries).toEqual([]);
    }
  });

  it("returns the same absence for an unavailable public profile", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      repository(sql).list({ craftsmanProfileId: profileId }),
    ).resolves.toBeNull();
    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toContain("publication.effectively_public");
    expect(sql.queries[0]).toContain("publication.review_state = 'APPROVED'");
    expect(sql.queries[0]).toContain("publication.owner_visibility = 'PUBLIC'");
    expect(sql.queries[0]).toContain(
      "publication.moderation_state = 'ALLOWED'",
    );
    expect(sql.queries[0]).toContain("owner.account_state = 'ACTIVE'");
  });

  it("lists only unlocked customer-to-provider profile reviews with a bounded stable cursor", async () => {
    const sql = scriptedSql([
      [{ profileId }],
      [publicRow(review1), publicRow(review2), publicRow(review3)],
    ]);
    const page = await repository(sql).list({
      craftsmanProfileId: profileId,
      limit: 2,
    });

    expect(page).toEqual({
      items: [
        {
          reviewId: review1,
          professionCode: "PROF:CARPENTER",
          ratings: ratings(),
          score: 4.5,
          comment: "Precízna a spoľahlivá práca.",
          reviewedMonth: "2026-09",
        },
        {
          reviewId: review2,
          professionCode: "PROF:CARPENTER",
          ratings: ratings(),
          score: 4.5,
          comment: "Precízna a spoľahlivá práca.",
          reviewedMonth: "2026-09",
        },
      ],
      nextCursor: `v1.${review2}`,
    });

    const reviewQuery = sql.queries[1] ?? "";
    expect(reviewQuery).toContain("FROM current_unlocked_job_main_reviews");
    expect(reviewQuery).toContain("review.direction = 'CUSTOMER_TO_PROVIDER'");
    expect(reviewQuery).toContain("review.target_kind = 'CRAFTSMAN_PROFILE'");
    expect(reviewQuery).toContain(
      "ORDER BY review.unlocked_at DESC, review.revision_id DESC",
    );
    expect(reviewQuery).toContain("AT TIME ZONE 'Europe/Bratislava'");
    expect(reviewQuery).not.toMatch(
      /job_main_review_events|job_id|actor_user_id|customer_profile|submitted_at|revised_at/iu,
    );
    expect(JSON.stringify(page)).not.toMatch(
      /jobId|customer|actor|address|phone|email|unlockedAt|submittedAt|revisedAt/iu,
    );
  });

  it("resolves an opaque cursor inside the same unlocked profile projection", async () => {
    const unlockedAt = new Date("2026-09-20T08:30:00.000Z");
    const sql = scriptedSql([
      [{ profileId }],
      [{ revisionId: review2, unlockedAt }],
      [publicRow(review3)],
    ]);
    const page = await repository(sql).list({
      craftsmanProfileId: profileId,
      cursor: `v1.${review2}`,
      limit: 2,
    });

    expect(page?.items.map(({ reviewId }) => reviewId)).toEqual([review3]);
    expect(page?.nextCursor).toBeNull();
    const anchorQuery = sql.queries[1] ?? "";
    const pageQuery = sql.queries[2] ?? "";
    for (const query of [anchorQuery, pageQuery]) {
      expect(query).toContain("current_unlocked_job_main_reviews");
      expect(query).toContain("review.direction = 'CUSTOMER_TO_PROVIDER'");
      expect(query).toContain("review.target_kind = 'CRAFTSMAN_PROFILE'");
    }
    expect(pageQuery).toContain("(review.unlocked_at, review.revision_id)");
  });

  it("rejects a syntactically valid cursor outside the eligible unlocked profile set", async () => {
    const sql = scriptedSql([[{ profileId }], []]);
    await expect(
      repository(sql).list({
        craftsmanProfileId: profileId,
        cursor: `v1.${review1}`,
      }),
    ).rejects.toBeInstanceOf(PublicCraftsmanReviewQueryValidationError);
    expect(sql.queries).toHaveLength(2);
  });

  it("suppresses unsafe free text while preserving the structured review", async () => {
    const sql = scriptedSql([
      [{ profileId }],
      [
        publicRow(review1, {
          comment: "Volajte mi na +421 900 123 456",
        }),
      ],
    ]);
    const page = await repository(sql).list({ craftsmanProfileId: profileId });
    expect(page?.items[0]).toMatchObject({
      reviewId: review1,
      comment: null,
      score: 4.5,
    });
  });

  it("fails closed for malformed ratings, identities, profession or month", async () => {
    for (const row of [
      publicRow("not-a-review"),
      publicRow(review1, { professionCode: "PRIVATE:UNKNOWN" }),
      publicRow(review1, { reviewedMonth: "2026-09-20" }),
      publicRow(review1, {
        ratings: { ...ratings(), forbidden_private_key: 5 },
      }),
      publicRow(review1, {
        ratings: { ...ratings(), work_quality: 6 },
      }),
      publicRow(review1, {
        ratings: Object.fromEntries(
          Object.keys(ratings()).map((key) => [key, null]),
        ),
      }),
    ]) {
      const sql = scriptedSql([[{ profileId }], [row]]);
      await expect(
        repository(sql).list({ craftsmanProfileId: profileId }),
      ).rejects.toBeInstanceOf(PublicCraftsmanReviewProjectionError);
    }
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
}

function repository(sql: Sql) {
  return createPublicCraftsmanReviewRepository(sql);
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const beginOptions: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (options: string, work: (transaction: Sql) => Promise<unknown>) => {
      beginOptions.push(options);
      return work(tagged);
    },
    beginOptions,
    queries,
  });
  return tagged;
}

function publicRow(
  revisionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    revisionId,
    professionCode: "PROF:CARPENTER",
    ratings: ratings(),
    comment: "Precízna a spoľahlivá práca.",
    reviewedMonth: "2026-09",
    jobId: "must-not-leak",
    actorUserId: "must-not-leak",
    customerProfileId: "must-not-leak",
    unlockedAt: "must-not-leak",
    ...overrides,
  };
}

function ratings() {
  return {
    work_quality: 5 as const,
    price_adherence: 4 as const,
    schedule_adherence: null,
    communication: 5 as const,
    cleanliness: 4 as const,
    problem_solving: null,
    would_hire_again: null,
  };
}
