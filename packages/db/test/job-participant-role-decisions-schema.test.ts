import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0091_job_participant_role_decisions.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("completed-Job role confirmation", () => {
  it("keeps one immutable participant decision for each exact assignment", () => {
    expect(migration).toContain("'CONFIRM', 'REQUEST_CORRECTION'");
    expect(migration).toContain("assignment_event_id uuid NOT NULL UNIQUE");
    expect(migration).toContain(
      "CREATE TRIGGER job_participant_role_decision_immutable",
    );
    expect(migration).toContain("AND role_interval.active");
    expect(migration).toContain("actor.id = profile.owner_user_id");
    expect(migration).toContain("role assignment required");
  });

  it("closes member and operational intervals on completion", () => {
    expect(migration).toContain(
      "least(participant.left_at, state.cancelled_at, evidence.completed_at)",
    );
    expect(migration).toContain(
      "state.cancelled_at, evidence.completed_at) AS ended_at",
    );
  });

  it("counts no unilateral or disputed operational role as verified", () => {
    expect(migration).toContain("CREATE VIEW verified_completed_job_roles");
    expect(migration).toContain("WITH (security_invoker = true)");
    expect(migration).toContain("decision.decision_kind = 'CONFIRM'");
    expect(migration).toContain(
      "role_interval.assignment_event_id IS NOT NULL",
    );
    expect(migration).toContain(
      "FROM verified_individual_completed_job_participation participation",
    );
  });
});
