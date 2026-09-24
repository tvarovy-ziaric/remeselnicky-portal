import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0095_job_participant_work_group_reviews.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("participant and historical work-group review foundation", () => {
  it("closes group assignments at completion and requires positive verified execution overlap", () => {
    expect(migration).toContain(
      "state.cancelled_at, completion.completed_at) AS ended_at",
    );
    expect(migration).toContain(
      "FROM verified_individual_completed_job_participation participation",
    );
    expect(migration).toMatch(
      /least\(assignment\.ended_at,[\s\S]*participation\.participation_ended_at\)[\s\S]*> greatest\(assignment\.assigned_at,[\s\S]*participation\.participation_started_at\)/u,
    );
    expect(migration).toContain(
      "participation.completion_kind = 'CUSTOMER_ACCEPTED'",
    );
  });

  it("derives participant and concrete group opportunities without Crew identity", () => {
    expect(migration).toContain("CREATE VIEW job_context_review_opportunities");
    expect(migration).toContain(
      "'PARTICIPANT'::job_context_review_target_kind",
    );
    expect(migration).toContain("'WORK_GROUP'::job_context_review_target_kind");
    expect(migration).toContain("JOIN job_work_groups work_group");
    expect(migration).toContain(
      "completion.completion_kind = 'CUSTOMER_ACCEPTED'",
    );
    expect(migration).toContain("AT TIME ZONE 'Europe/Bratislava'");
    expect(migration).toContain("interval '14 days'");
    expect(migration).not.toMatch(/JOIN\s+crews\b/iu);
    expect(migration).not.toMatch(/crew_id\s*=/iu);
  });

  it("enforces exactly one concrete target and one logical review per target", () => {
    expect(migration).toMatch(
      /CONSTRAINT job_context_review_exact_target CHECK \([\s\S]*target_kind = 'PARTICIPANT'[\s\S]*participant_id IS NOT NULL AND work_group_id IS NULL[\s\S]*target_kind = 'WORK_GROUP'[\s\S]*participant_id IS NULL AND work_group_id IS NOT NULL/u,
    );
    expect(migration).toContain(
      "CREATE UNIQUE INDEX job_context_review_one_participant",
    );
    expect(migration).toContain(
      "CREATE UNIQUE INDEX job_context_review_one_work_group",
    );
    expect(migration).toContain("FOREIGN KEY (job_id, participant_id)");
    expect(migration).toContain("FOREIGN KEY (job_id, work_group_id)");
  });

  it("snapshots only verified completed capabilities, roles and assignment intervals", () => {
    expect(migration).toContain(
      "FROM verified_completed_job_capabilities capability",
    );
    expect(migration).toContain(
      "FROM verified_completed_job_roles role_evidence",
    );
    expect(migration).toContain(
      "FROM verified_completed_job_work_group_assignments assignment",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_context_review_snapshot_provenance",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_participant_review_capability_snapshot_immutable",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_participant_review_role_snapshot_immutable",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_work_group_review_assignment_snapshot_immutable",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_participant_review_capability_snapshot_validate",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_participant_review_role_snapshot_validate",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_work_group_review_assignment_snapshot_validate",
    );
    expect(migration).toContain(
      "exact verified completed-Job capability required",
    );
    expect(migration).toContain("exact verified completed-Job role required");
    expect(migration).toContain(
      "exact verified work-group assignment overlap required",
    );
    expect(
      migration.match(/IS NOT DISTINCT FROM NEW\./gu)?.length,
    ).toBeGreaterThanOrEqual(20);
  });

  it("keeps logical identities and revision streams immutable and race-safe", () => {
    expect(migration).toContain("create_command_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("UNIQUE (review_id, version)");
    expect(migration).toContain(
      "WHERE create_command_id = NEW.create_command_id",
    );
    expect(migration).toContain("WHERE event_id = NEW.event_id");
    expect(migration.match(/RETURN NULL;/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain(
      "context review command identifier reuse conflict",
    );
    expect(migration).toContain(
      "context review event identifier reuse conflict",
    );
    expect(migration).toContain("WHERE review_id = NEW.review_id FOR UPDATE");
    expect(migration).toContain(
      "PERFORM 1 FROM jobs WHERE id = review_row.job_id FOR UPDATE",
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("CREATE TRIGGER job_context_review_immutable");
    expect(migration).toContain(
      "CREATE TRIGGER job_context_review_revision_immutable",
    );
  });

  it("uses exact nullable participant and team dimensions with substantive 1-to-5 answers", () => {
    for (const key of [
      "work_quality",
      "price_adherence",
      "schedule_adherence",
      "communication",
      "cleanliness",
      "problem_solving",
      "would_hire_again",
      "result_quality",
      "coordination",
      "timing",
    ]) {
      expect(migration).toContain(`'${key}'`);
    }
    expect(migration).toContain("actual_count <> cardinality(expected_keys)");
    expect(migration).toContain("item.value <> 'null'::jsonb");
    expect(migration).toContain(
      "item.value::text NOT IN ('1', '2', '3', '4', '5')",
    );
    expect(migration).toContain(
      "item.value::text IN ('1', '2', '3', '4', '5')",
    );
    expect(migration).toContain("interval '60 minutes'");
  });

  it("keeps team evidence separate from member reputation", () => {
    expect(migration).toContain(
      "work-group scores remain separate and are never propagated to member reputation",
    );
    expect(migration).not.toMatch(
      /INSERT INTO\s+(?:current_)?(?:searchable_)?[^\s;]*(?:trust|reputation|score)/iu,
    );
    expect(migration).toContain("WITH (security_invoker = true)");
  });
});
