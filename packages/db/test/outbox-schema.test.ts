import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  domainOutboxEvents,
  OUTBOX_EVENT_STATUS_VALUES,
  outboxConsumerEffects,
} from "../src/index.js";

describe("transactional outbox schema", () => {
  it("exposes stable delivery states and typed tables", () => {
    expect(OUTBOX_EVENT_STATUS_VALUES).toEqual([
      "PENDING",
      "PROCESSING",
      "PUBLISHED",
      "TERMINAL",
    ]);
    expect(domainOutboxEvents.eventId.name).toBe("event_id");
    expect(outboxConsumerEffects.consumerName.name).toBe("consumer_name");
  });

  it("locks in dedupe, lease, retry, monitoring and payload constraints", async () => {
    const migration = await readFile(
      new URL("../migrations/0007_transactional_outbox.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("UNIQUE (idempotency_key)");
    expect(migration).toContain("outbox_payload_is_minimal(payload)");
    expect(migration).toContain("octet_length(payload::text) <= 8192");
    expect(migration).toContain("status = 'PROCESSING'");
    expect(migration).toContain("lease_expires_at IS NOT NULL");
    expect(migration).toContain("domain_outbox_events_pending_idx");
    expect(migration).toContain("domain_outbox_events_expired_lease_idx");
    expect(migration).toContain("PRIMARY KEY (consumer_name, event_id)");
    expect(migration).toContain(
      "idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'",
    );
    expect(migration).toContain(
      "correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'",
    );
    expect(migration).toContain(
      "entity_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'",
    );
    expect(migration).toContain(
      "(item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'",
    );
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
  });
});
