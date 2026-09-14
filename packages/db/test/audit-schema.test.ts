import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { auditEvents } from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0011_immutable_audit_log.sql", import.meta.url),
  ),
  "utf8",
);
const repository = readFileSync(
  fileURLToPath(new URL("../src/audit-repository.ts", import.meta.url)),
  "utf8",
);

describe("immutable audit persistence", () => {
  it("uses stable event/correlation/actor/action/target and DB-owned time fields", () => {
    expect(auditEvents.eventId.name).toBe("event_id");
    expect(auditEvents.correlationId.name).toBe("correlation_id");
    expect(auditEvents.actorUserId.name).toBe("actor_user_id");
    expect(auditEvents.actionType.name).toBe("action_type");
    expect(auditEvents.targetId.name).toBe("target_id");
    expect(auditEvents.occurredAt.name).toBe("occurred_at");
    expect(migration).toContain("NEW.occurred_at := CURRENT_TIMESTAMP");
    expect(repository).not.toMatch(/occurred_at\s*\n\s*\)/u);
  });

  it("denies ordinary mutation and exposes append persistence only", () => {
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON audit_events");
    expect(migration).toContain("audit events are append-only");
    expect(repository).toContain("INSERT INTO audit_events");
    expect(repository).not.toMatch(
      /UPDATE audit_events|DELETE FROM audit_events/iu,
    );
  });

  it("enforces safe allowlisted diffs and sensitive-access purpose/context", () => {
    expect(migration).toContain("audit_diff_is_safe(changes)");
    expect(migration).toContain("category = 'SENSITIVE_ACCESS'");
    expect(migration).toContain("sensitive_access_purpose IS NOT NULL");
    expect(migration).not.toMatch(
      /chat_body|email_address|phone_number|document_content|signed_url|password_hash/iu,
    );
  });

  it("mirrors the authoritative role ledger atomically without dual writes", () => {
    expect(migration).toContain("FROM admin_role_change_events AS source");
    expect(migration).toContain("source.occurred_at");
    expect(migration).toContain("AFTER INSERT ON admin_role_change_events");
    expect(migration).toContain("source_admin_role_change_event_id");
    expect(migration).toContain("NEW.event_id");
    expect(migration).toContain("admin.roles.manage");
    expect(repository).not.toContain("source_admin_role_change_event_id");
  });

  it("is race-safe and rejects event-id reuse with a different payload", () => {
    expect(repository).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(repository).toContain("Audit event idempotency conflict");
  });
});
