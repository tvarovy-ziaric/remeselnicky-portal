import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0096_job_supervisor_evaluations.sql", import.meta.url),
  "utf8",
);

describe("Job supervisor evaluation foundation", () => {
  it("derives only explicit responsible relationships with positive overlap", () => {
    expect(migration).toContain(
      "CREATE VIEW job_supervisor_evaluation_relationships",
    );
    expect(migration).toContain("'PRIMARY_CONTRACTOR'");
    expect(migration).toContain(
      "evaluator_role.role IN ('COORDINATOR', 'SITE_MANAGER')",
    );
    expect(migration).toContain("evaluator_role.role = 'LEAD'");
    expect(migration).toContain(
      "JOIN verified_completed_job_work_group_assignments evaluator_group",
    );
    expect(migration).toContain(
      "target_group.work_group_id = evaluator_group.work_group_id",
    );
    expect(migration).toMatch(
      /least\(evaluator_role\.role_ended_at,[\s\S]*> greatest\(evaluator_role\.role_started_at,/u,
    );
    expect(migration).not.toMatch(/CrewMembership|current_crew_memberships/u);
  });

  it("requires customer-accepted verified Job participation and denies self evaluation", () => {
    expect(migration).toContain(
      "FROM verified_individual_completed_job_participation target",
    );
    expect(
      migration.match(/target\.completion_kind = 'CUSTOMER_ACCEPTED'/gu),
    ).toHaveLength(3);
    expect(migration).toContain("target.completion_decision_id IS NOT NULL");
    expect(migration).toContain(
      "evaluator_profile.owner_user_id <> target_profile.owner_user_id",
    );
    expect(migration).toContain(
      "provider.owner_user_id <> target_profile.owner_user_id",
    );
  });

  it("deduplicates multi-role opportunities deterministically and uses the 14-day local deadline", () => {
    expect(migration).toContain(
      "PARTITION BY relationship.job_id, relationship.evaluator_user_id",
    );
    expect(migration).toContain("WHEN 'PRIMARY_CONTRACTOR' THEN 1");
    expect(migration).toContain("WHEN 'SITE_MANAGER' THEN 2");
    expect(migration).toContain("WHEN 'COORDINATOR' THEN 3");
    expect(migration).toContain("WHERE relationship_rank = 1");
    expect(migration).toContain("AT TIME ZONE 'Europe/Bratislava'");
    expect(migration).toContain("interval '14 days'");
  });

  it("freezes target, completion, relationship, profession and role provenance", () => {
    expect(migration).toContain(
      "UNIQUE (job_id, evaluator_user_id, target_participant_id)",
    );
    expect(migration).toContain("FOREIGN KEY (job_id, target_participant_id)");
    expect(migration).toContain("job_supervisor_evaluation_relationship_shape");
    expect(migration).toContain(
      "CREATE TABLE job_supervisor_evaluation_profession_snapshots",
    );
    expect(migration).toContain(
      "CREATE TABLE job_supervisor_evaluation_role_snapshots",
    );
    expect(migration).toContain("capability.kind = 'PROFESSION'");
    expect(migration).toContain("exact verified target profession required");
    expect(migration).toContain("exact verified target role required");
    expect(
      migration.match(/IS NOT DISTINCT FROM NEW\./gu)?.length,
    ).toBeGreaterThan(12);
  });

  it("uses immutable command-idempotent revisions with exact dimensions", () => {
    expect(migration).toContain("create_command_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("UNIQUE (evaluation_id, version)");
    expect(migration).toContain(
      "WHERE create_command_id = NEW.create_command_id",
    );
    expect(migration).toContain("WHERE event_id = NEW.event_id");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("interval '60 minutes'");
    for (const key of [
      "competence_quality",
      "reliability",
      "independence",
      "productivity",
      "collaboration",
      "problem_solving",
      "would_take_into_crew_again",
    ])
      expect(migration).toContain(`'${key}'`);
    expect(migration).toContain("item.value <> 'null'::jsonb");
    expect(migration).toContain(
      "exact substantive supervisor ratings required",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_supervisor_evaluation_immutable",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_supervisor_evaluation_revision_immutable",
    );
  });

  it("notifies the target once without raw evaluation content", () => {
    expect(migration).toContain("IF NEW.version <> 1 THEN RETURN NULL");
    expect(migration).toContain("'job.review.supervisor.visible'");
    expect(migration).toContain("'recipient_user_id', recipient_id::text");
    expect(migration).toContain(
      "'evaluation_id', evaluation.evaluation_id::text",
    );
    const notification = migration.slice(
      migration.indexOf(
        "CREATE FUNCTION emit_job_supervisor_evaluation_notification",
      ),
      migration.indexOf("-- Only stable, edit-locked evidence"),
    );
    expect(notification).not.toContain("ratings");
    expect(notification).not.toContain("comment");
  });

  it("publishes only stable profession-scoped counts and keeps quality formulas deferred", () => {
    expect(migration).toContain(
      "CREATE VIEW current_locked_supervisor_evaluation_professions",
    );
    expect(migration).toContain(
      "clock_timestamp() >= evaluation.edit_deadline",
    );
    expect(migration).toContain(
      "count(DISTINCT evaluation.evaluation_id)::integer",
    );
    expect(migration).toContain("AS supervisor_evaluation_count");
    expect(
      migration.match(/false AS supervisor_quality_available/gu),
    ).toHaveLength(2);
    expect(migration).not.toMatch(/supervisor_score/iu);
    expect(migration).not.toMatch(/avg\([^)]*supervisor/iu);
  });
});
