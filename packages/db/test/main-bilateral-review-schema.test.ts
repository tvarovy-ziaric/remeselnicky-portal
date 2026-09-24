import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0092_main_bilateral_review_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("main bilateral review foundation", () => {
  it("derives only two non-self opportunities from completed provenance with one fixed deadline", () => {
    expect(migration).toContain(
      "FROM completed_job_evidence_provenance evidence",
    );
    expect(migration).toContain("'CUSTOMER_TO_PROVIDER'");
    expect(migration).toContain("'PROVIDER_TO_CUSTOMER'");
    expect(migration).toContain(
      "customer.owner_user_id <> provider.owner_user_id",
    );
    expect(
      migration.match(/evidence\.completion_kind = 'CUSTOMER_ACCEPTED'/g),
    ).toHaveLength(2);
    expect(migration).toContain("AT TIME ZONE 'Europe/Bratislava'");
    expect(migration).toContain("interval '14 days'");
  });

  it("serializes immutable submissions and edits with exact dimensions and one substantive score", () => {
    expect(migration).toContain(
      "PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE",
    );
    expect(migration).toContain("UNIQUE (job_id, direction, version)");
    expect(migration).toContain("WHERE event_id = NEW.event_id");
    expect(migration).toContain("RETURN NULL;");
    expect(migration).toContain("review command identifier reuse conflict");
    expect(migration).toContain("actual_count <> cardinality(expected_keys)");
    expect(migration).toContain("NOT EXISTS (");
    expect(migration).toContain(
      "item.value::text IN ('1', '2', '3', '4', '5')",
    );
    expect(migration).toContain("interval '60 minutes'");
    expect(migration).toContain(
      "CREATE TRIGGER job_main_review_event_immutable",
    );
  });

  it("does not reveal a single sealed submission before reciprocal submission or deadline", () => {
    expect(migration).toContain(
      "CREATE VIEW current_unlocked_job_main_reviews",
    );
    expect(migration).toContain("opposite.submitted_at IS NOT NULL");
    expect(migration).toContain(
      "clock_timestamp() >= opportunity.submission_deadline",
    );
    expect(migration).toContain("WITH (security_invoker = true)");
  });
});
