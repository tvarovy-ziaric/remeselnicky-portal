import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createJobInvitationReminderRepository } from "../src/job-invitation-notification-repository.js";

describe("job invitation notification persistence", () => {
  it("captures send and expiry events in the invitation transaction", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/0043_job_invitation_notifications.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("AFTER INSERT ON job_invitation_revisions");
    expect(migration).toContain("job_invitation.sent");
    expect(migration).toContain("job_invitation.expired");
    expect(migration).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(migration).not.toMatch(
      /email|phone|exact_address|description|decline_note/iu,
    );
  });

  it("selects only pending invitations inside the configurable warning window", async () => {
    const statements: string[] = [];
    const transaction = vi.fn((parts: TemplateStringsArray) => {
      statements.push(parts.join("?"));
      return Promise.resolve([{ invitationId: crypto.randomUUID() }]);
    });
    const sql = Object.assign(vi.fn(), {
      begin: vi.fn((work: (value: typeof transaction) => Promise<unknown>) =>
        work(transaction),
      ),
    });
    await expect(
      createJobInvitationReminderRepository(sql as never).enqueueDueReminders(),
    ).resolves.toHaveLength(1);
    const query = statements.join("\n");
    expect(query).toContain("warning_lead_days");
    expect(query).toContain("current.state = 'PENDING'");
    expect(query).toContain("FOR UPDATE OF invitation SKIP LOCKED");
    expect(query).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
  });
});
