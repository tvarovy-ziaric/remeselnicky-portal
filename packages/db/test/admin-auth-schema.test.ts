import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adminMfaChallenges,
  adminMfaFactors,
  adminPrivilegedSessions,
  adminRoleChangeEvents,
  adminRoleGrants,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0009_admin_privileged_access.sql", import.meta.url),
  ),
  "utf8",
);
const repository = readFileSync(
  fileURLToPath(new URL("../src/admin-auth-repository.ts", import.meta.url)),
  "utf8",
);

describe("admin privileged persistence", () => {
  it("defines separate roles, MFA factors, one-shot challenges and privileged sessions", () => {
    expect(adminRoleGrants.userId.name).toBe("user_id");
    expect(adminMfaFactors.credentialReference.name).toBe(
      "credential_reference",
    );
    expect(adminMfaChallenges.challengeDigest.name).toBe("challenge_digest");
    expect(adminPrivilegedSessions.sessionIdHash.name).toBe("session_id_hash");
    expect(adminRoleChangeEvents.eventId.name).toBe("event_id");
  });

  it("stores provider references and digests, never raw MFA or recovery secrets", () => {
    expect(migration).toContain("challenge_digest character(64)");
    expect(migration).toContain("credential_reference text NOT NULL");
    expect(migration).not.toMatch(/totp_secret|recovery_code|private_key/iu);
    expect(repository).not.toMatch(/totp_secret|recovery_code|private_key/iu);
  });

  it("makes role events append-only and forbids self role changes in the database", () => {
    expect(migration).toContain(
      "CONSTRAINT admin_role_change_events_no_self_change",
    );
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("admin role change events are append-only");
  });

  it("binds privileged sessions to revocable base sessions and active server-side grants", () => {
    expect(migration).toContain(
      "REFERENCES auth_sessions(session_id_hash) ON DELETE CASCADE",
    );
    expect(repository).toContain("users.account_state = 'ACTIVE'");
    expect(repository).toContain("role.revoked_at IS NULL");
    expect(repository).toContain("base.revoked_at IS NULL");
    expect(repository).toContain("factor.revoked_at IS NULL");
  });

  it("writes each role mutation and its event in the same transaction", () => {
    expect(repository).toContain("return sql.begin(async (transaction)");
    expect(repository).toContain("INSERT INTO admin_role_change_events");
    expect(repository).toContain("UPDATE admin_privileged_sessions");
  });
});
