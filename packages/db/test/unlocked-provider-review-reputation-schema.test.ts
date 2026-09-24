import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0094_unlocked_provider_review_reputation.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("unlocked provider review reputation schema", () => {
  it("projects only unlocked customer-to-provider review scores", () => {
    expect(migration).toContain("current_unlocked_job_main_reviews");
    expect(migration).toContain("review.direction = 'CUSTOMER_TO_PROVIDER'");
    expect(migration).toContain("review.target_kind = 'CRAFTSMAN_PROFILE'");
    expect(migration).toContain("jsonb_typeof(rating.value) = 'number'");
    expect(migration).toMatch(/avg\(\(rating\.value #>> '\{\}'\)::numeric\)/u);
  });

  it("keeps profession context and evidence volume inspectable", () => {
    expect(migration).toContain(
      "review.accepted_profession_code AS profession_code",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE VIEW current_searchable_profession_trust_evidence",
    );
    expect(migration).toContain(
      "COALESCE(reputation.review_count, 0)::integer AS customer_review_count",
    );
    expect(migration).toContain("count(DISTINCT completed.job_id)::integer");
  });

  it("does not promote a small sample into ranking confidence", () => {
    expect(migration).toContain("false AS review_sample_sufficient");
    expect(
      migration.match(
        /'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence/gu,
      ),
    ).toHaveLength(2);
    expect(migration).not.toMatch(/['"]SUFFICIENT_SAMPLE|bayes|coefficient/iu);
  });

  it("keeps private provenance and review text out of aggregate projections", () => {
    const aggregateSection = migration.slice(
      migration.indexOf(
        "CREATE VIEW current_unlocked_provider_main_review_scores",
      ),
      migration.indexOf(
        "CREATE OR REPLACE VIEW current_searchable_trust_evidence_summaries",
      ),
    );
    expect(aggregateSection).not.toMatch(
      /actor_user_id|author_user_id|customer_profile_id|job_id|comment|address|email|phone/iu,
    );
  });
});
