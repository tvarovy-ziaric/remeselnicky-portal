import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0090_completed_job_work_volume.sql", import.meta.url),
  "utf8",
);

describe("completed-Job factual work volume", () => {
  it("requires accepted participation to overlap actual execution", () => {
    expect(migration).toContain("job_state.started_at IS NOT NULL");
    expect(migration).toContain(
      "LEAST(participant.left_at, evidence.completed_at)",
    );
    expect(migration).toContain(
      "> GREATEST(participant.accepted_at, job_state.started_at)",
    );
    expect(migration).toContain(
      "GREATEST(participant.accepted_at, job_state.started_at)",
    );
    expect(migration).toContain(
      "participant.accepted_at AS participation_accepted_at",
    );
  });

  it("counts distinct company and individual completed Jobs without multiplying claims", () => {
    expect(migration).toContain("FROM verified_company_completed_jobs");
    expect(migration).toContain(
      "FROM verified_individual_completed_job_participation",
    );
    expect(migration).toContain("FROM verified_completed_job_capabilities");
    expect(migration).toContain("WHERE kind = 'PROFESSION'");
    expect(
      migration.match(/count\(DISTINCT completed\.job_id\)/gu),
    ).toHaveLength(3);
    expect(migration).toContain(
      "completed.profession_code = profession.profession_code",
    );
  });

  it("keeps public projections aggregate and searchable-profile scoped", () => {
    expect(migration.match(/security_invoker = true/gu)).toHaveLength(6);
    expect(migration).toContain(
      "FROM current_searchable_craftsman_profiles searchable",
    );
    expect(migration).toContain(
      "FROM current_searchable_craftsman_professions profession",
    );
    expect(migration).not.toMatch(
      /AS "?(?:jobId|customerId|participantId|claimId|ownerId)"?/iu,
    );
  });
});
