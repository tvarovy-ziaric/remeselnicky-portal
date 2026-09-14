import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0034_trust_evidence_read_model.sql", import.meta.url),
  "utf8",
);

describe("trust/evidence read-model migration", () => {
  it("builds additive security-invoker views on the public search intersection", () => {
    expect(migration).toContain(
      "CREATE VIEW current_searchable_trust_evidence_summaries",
    );
    expect(migration).toContain(
      "CREATE VIEW current_searchable_profession_trust_evidence",
    );
    expect(migration.match(/security_invoker = true/gu)).toHaveLength(2);
    expect(migration).toContain("current_searchable_craftsman_profiles");
    expect(migration).toContain("current_searchable_craftsman_professions");
  });

  it("keeps unavailable R4 quality and confidence neutral and explicit", () => {
    expect(
      migration.match(/0::integer AS customer_review_count/gu),
    ).toHaveLength(2);
    expect(migration.match(/0::integer AS verified_job_count/gu)).toHaveLength(
      2,
    );
    expect(migration.match(/NULL::numeric AS customer_score/gu)).toHaveLength(
      2,
    );
    expect(migration.match(/'INSUFFICIENT_SAMPLE'::text/gu)).toHaveLength(6);
    expect(migration).not.toMatch(/0::numeric AS customer_score/iu);
  });

  it("counts only distinct authoritative credential types and verified projects", () => {
    expect(
      migration.match(/count\(DISTINCT credential\.credential_type_code\)/gu),
    ).toHaveLength(2);
    expect(
      migration.match(
        /count\(DISTINCT (?:project|public_project)\.portfolio_project_id\)/gu,
      ),
    ).toHaveLength(2);
    expect(migration.match(/evidence_status = 'VERIFIED'/gu)).toHaveLength(2);
    expect(migration).not.toMatch(/photo|attachment|revision/iu);
  });

  it("uses exact profession relevance and exposes no sensitive source data", () => {
    expect(migration).toContain(
      "credential.profession_code = profession.profession_code",
    );
    expect(migration).toContain(
      "project_profession.profession_code = profession.profession_code",
    );
    expect(migration).toContain(
      "profession.profession_code = ANY(skill.profession_codes)",
    );
    expect(migration).not.toMatch(
      /review_body|comment_text|customer_user_id|reviewer_user_id|evaluator_user_id|owner_user_id|job_id|claim_id|storage_key|sha256|email|phone|paid|founder|completeness|rank_score/iu,
    );
  });
});
