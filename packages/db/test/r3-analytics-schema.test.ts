import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0053_r3_analytics_funnel.sql", import.meta.url),
  ),
  "utf8",
);
const repository = readFileSync(
  fileURLToPath(new URL("../src/r3-analytics-repository.ts", import.meta.url)),
  "utf8",
);

describe("0053 R3 analytics funnel schema", () => {
  it("owns an independent reclaimable consumer without global outbox mutation", () => {
    expect(migration).toContain("CREATE TABLE r3_analytics_event_deliveries");
    expect(repository).toContain("FOR UPDATE OF delivery SKIP LOCKED");
    expect(migration).toContain("lease_expires_at");
    expect(repository).not.toMatch(
      /UPDATE domain_outbox_events[\s\S]{0,180}status\s*=/u,
    );
  });

  it("captures privacy-minimal immutable effects and bounded buckets", () => {
    expect(migration).toContain("'budget_provided', coalesce(budget_payload");
    expect(migration).toContain("IN ('UP_TO', 'RANGE')");
    expect(migration).toContain("'TWO_TO_FOUR'");
    expect(migration).toContain("'FIVE_TO_NINE'");
    expect(migration).toContain("'TEN_PLUS'");
    expect(migration).toContain("'FIVE_TO_TEN'");
    expect(migration).toContain("'attachment_type_bucket'");
    expect(migration).not.toContain("'message_id', NEW.provenance_entity_id");
    expect(migration).not.toMatch(
      /r3_analytics_subject_payload\([^)]*(?:body|address|storage|email|phone|filename|sha256)/iu,
    );
  });

  it("keeps UX observations consented, server-authored and external PDFs exact", () => {
    expect(migration).toContain("hashtext('NON_ESSENTIAL_ANALYTICS')");
    expect(migration).toContain("actor.account_state = 'ACTIVE'");
    expect(migration).toContain("quote_revision_authoring_is_eligible(");
    expect(migration).toContain("NEW.source_event_id := gen_random_uuid()");
    expect(migration).toContain("REFERENCES domain_outbox_events(event_id)");
    expect(migration).toContain("NEW.observed_at := clock_timestamp()");
  });

  it("classifies TEST before current admin INTERNAL and defaults only absence to REAL", () => {
    expect(migration).toContain("WHEN explicit.traffic_class = 'TEST'");
    expect(migration).toContain("FROM admin_role_grants grant_row");
    expect(migration).toContain("grant_row.revoked_at IS NULL");
    expect(migration).toContain("ELSE 'REAL'::analytics_traffic_class");
  });

  it("has one authoritative append-only classification-history guard", () => {
    expect(
      migration.match(
        /BEFORE UPDATE OR DELETE ON user_analytics_traffic_classification_events/gu,
      ),
    ).toHaveLength(1);
  });
});
