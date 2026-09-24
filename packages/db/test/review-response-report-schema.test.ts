import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0097_review_responses_and_reports.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("review response and report foundation", () => {
  it("binds one response to the final unlocked public review and its rated owner", () => {
    expect(migration).toContain("CREATE TABLE job_main_review_responses");
    expect(migration).toContain("review_revision_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("UNIQUE (job_id, direction)");
    expect(migration).toContain("direction = 'CUSTOMER_TO_PROVIDER'");
    expect(migration).toContain("FROM current_unlocked_job_main_reviews");
    expect(migration).toContain("NEW.author_user_id IS DISTINCT FROM owner_id");
    expect(migration).toContain(
      "NEW.author_user_id IS NOT DISTINCT FROM review.actor_user_id",
    );
  });

  it("keeps one append-only response stream with a short edit window", () => {
    expect(migration).toContain("CREATE TABLE job_main_review_response_events");
    expect(migration).toContain("UNIQUE (response_id, version)");
    expect(migration).toContain("interval '60 minutes'");
    expect(migration).toContain("first review response revision required");
    expect(migration).toContain(
      "CREATE TRIGGER job_main_review_response_immutable",
    );
    expect(migration).toContain(
      "CREATE TRIGGER job_main_review_response_event_immutable",
    );
    expect(migration).not.toMatch(
      /\b(?:reply_to|parent_response|thread_parent)_id\b/iu,
    );
  });

  it("creates separate immutable reports for the three R4-020 targets", () => {
    expect(migration).toContain("CREATE TABLE moderation_reports");
    for (const target of [
      "MAIN_REVIEW",
      "REVIEW_RESPONSE",
      "SUPERVISOR_EVALUATION",
    ])
      expect(migration).toContain(`'${target}'`);
    expect(migration).toContain(
      "UNIQUE (reporter_user_id, target_type, target_id)",
    );
    expect(migration).toContain("active verified reporter required");
    expect(migration).toContain("profile.owner_user_id = NEW.reporter_user_id");
    expect(migration).toContain("CREATE TRIGGER moderation_report_immutable");
  });

  it("uses governed review reasons and an append-only five-state workflow", () => {
    for (const reason of [
      "PERSONAL_DATA_PRIVACY",
      "HARASSMENT_ABUSE",
      "EXTORTION_RETALIATION",
      "IRRELEVANT_CONTENT",
      "SUSPECTED_FRAUD_FAKE_REVIEW",
      "OTHER",
    ])
      expect(migration).toContain(`'${reason}'`);
    for (const state of [
      "OPEN",
      "UNDER_REVIEW",
      "ACTIONED",
      "NO_VIOLATION",
      "CLOSED",
    ])
      expect(migration).toContain(`'${state}'`);
    expect(migration).toContain("CREATE TABLE moderation_report_state_events");
    expect(migration).toContain("exact initial report state required");
    expect(migration).toContain("sequential admin report state required");
    expect(migration).toContain(
      "CREATE TRIGGER moderation_report_state_event_immutable",
    );
  });

  it("does not make report intake a visibility or reputation action", () => {
    const reportSection = migration.slice(
      migration.indexOf("CREATE TABLE moderation_reports"),
      migration.indexOf("COMMENT ON TABLE job_main_review_responses"),
    );
    expect(reportSection).not.toMatch(
      /UPDATE\s+(?:job_main_review_events|job_supervisor_evaluations|craftsman_profiles|users)/iu,
    );
    expect(reportSection).not.toMatch(/DELETE\s+FROM/iu);
    expect(reportSection).not.toMatch(/customer_score|review_score|rating/iu);
    expect(migration).toContain(
      "Creation is a claim only and has no automatic visibility, reputation or account effect.",
    );
  });
});
