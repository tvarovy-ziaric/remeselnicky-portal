import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0032_credential_qualification_gate.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("R2 credential qualification SQL boundary", () => {
  it("keeps legal rules as an unseeded append-only versioned release", () => {
    expect(migration).toContain(
      "CREATE TABLE credential_qualification_policy_releases",
    );
    expect(migration).toContain("checksum_sha256 char(64) NOT NULL UNIQUE");
    expect(migration).toContain(
      "CREATE TABLE credential_qualification_policy_activation_events",
    );
    expect(migration).toMatch(
      /version integer NOT NULL UNIQUE CHECK \(version > 0\)/u,
    );
    expect(migration).toMatch(/releases are append-only/u);
    expect(migration).toMatch(/entries are append-only/u);
    expect(migration).toMatch(/activations are append-only/u);
    expect(migration).not.toMatch(
      /INSERT INTO credential_qualification_policy_(?:releases|entries|activation_events)/u,
    );
    expect(migration).toContain("installation_txid bigint NOT NULL");
    expect(migration).toContain(
      "entries must be installed atomically with their release",
    );
  });

  it("activates only coherent expert-reviewed canonical full releases", () => {
    expect(migration).toContain("HUMAN_REVIEW_APPROVED");
    expect(migration).toContain("content_class <> 'CANONICAL'");
    expect(migration).toContain("policy release cannot be empty");
    expect(migration).toContain(
      "policy must target the current profession taxonomy",
    );
    expect(migration).toContain("profession.state IS DISTINCT FROM 'ACTIVE'");
    expect(migration).toContain("credential.active IS DISTINCT FROM true");
    expect(migration).toContain("policy versions must be contiguous");
    expect(migration).toContain("pg_advisory_xact_lock(20060032)");
    expect(migration).toContain(
      "LOCK TABLE profession_taxonomy_activation_events IN SHARE MODE",
    );
    expect(migration).toContain("COALESCE(latest_version, 0) + 1");
    expect(migration).toContain("supersession is stale");
  });

  it("uses exact current public credential facts for a SECURITY INVOKER gate", () => {
    expect(migration).toContain(
      "CREATE FUNCTION evaluate_craftsman_credential_qualification",
    );
    expect(migration).toContain("STABLE");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("current_searchable_craftsman_profiles");
    expect(migration).toContain("current_searchable_craftsman_credentials");
    expect(migration).toMatch(
      /credential\.profession_code = requested_profession_code[\s\S]*credential\.credential_type_code = requested_credential_type_code/u,
    );
    expect(migration).not.toMatch(
      /claim\.state|claim\.expires_on|evidence_requirement\s*=\s*'REQUIRED'/u,
    );
  });

  it("returns only deterministic qualification facts", () => {
    const returns = migration.match(
      /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/u,
    )?.[1];
    expect(returns).toBeDefined();
    expect(returns).toMatch(
      /eligibility credential_qualification_eligibility/u,
    );
    expect(returns).toMatch(
      /requirement credential_qualification_requirement/u,
    );
    expect(returns).toMatch(/current_approved boolean/u);
    expect(returns).toMatch(/reason_code credential_qualification_reason/u);
    expect(returns).not.toMatch(
      /claim|evidence|media|reviewer|review_reason|storage|hash|owner|user_id/u,
    );
  });
});
