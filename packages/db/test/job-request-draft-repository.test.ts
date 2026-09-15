import { createHash } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  JobRequestDraftIdempotencyError,
  normalizeJobRequestDraftSection,
  type CustomerProfileId,
  type JobRequestId,
  type UserId,
} from "@portal/domain";

import { createJobRequestDraftRepository } from "../src/job-request-draft-repository.js";

const actor = "97000000-0000-4000-8000-000000000001" as UserId;
const customer = "97000000-0000-4000-8000-000000000002" as CustomerProfileId;
const request = "97000000-0000-4000-8000-000000000003" as JobRequestId;
const command = "97000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-15T14:00:00.000Z");
const section = normalizeJobRequestDraftSection({
  key: "request.basics",
  payload: { note: "oprava strechy", urgency: "NORMAL" },
  schemaVersion: 1,
});

describe("job request draft repository", () => {
  it("appends one revision and private section effect for a changed autosave", async () => {
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [currentDraft(1)],
      [],
      [{ count: 0 }],
      [{ createdAt: now }],
      [],
      [],
    ]);

    await expect(
      createJobRequestDraftRepository(harness.sql).autosaveOwned({
        actorUserId: actor,
        commandId: command,
        expectedRevision: 1,
        jobRequestId: request,
        section,
      }),
    ).resolves.toEqual({
      jobRequestId: request,
      revision: 2,
      savedAt: now,
      status: "APPLIED",
    });
    expect(harness.statements[0]).toMatch(/account_state = 'ACTIVE'/u);
    expect(harness.statements.join("\n")).toContain(
      "INSERT INTO job_request_draft_section_revisions",
    );
  });

  it("records canonical-equivalent content as durable UNCHANGED without effects", async () => {
    const fingerprint = sha256(section.canonicalPayload);
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [currentDraft(2)],
      [sectionRow(fingerprint)],
      [{ createdAt: now }],
    ]);

    await expect(
      createJobRequestDraftRepository(harness.sql).autosaveOwned({
        actorUserId: actor,
        commandId: command,
        expectedRevision: 2,
        jobRequestId: request,
        section,
      }),
    ).resolves.toMatchObject({ revision: 2, status: "UNCHANGED" });
    expect(harness.statements.join("\n")).not.toContain(
      "INSERT INTO job_request_revisions",
    );
  });

  it("checks ACTIVE ownership before exact replay and rejects collisions", async () => {
    const fingerprint = sha256(section.canonicalPayload);
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [],
      [
        {
          actorUserId: actor,
          commandKind: "AUTOSAVE",
          createdAt: now,
          customerProfileId: customer,
          draftPayloadFingerprint: fingerprint,
          draftSectionKey: section.key,
          draftSectionSchemaVersion: section.schemaVersion,
          jobRequestId: request,
          payloadFingerprint: "0".repeat(64),
          resultKind: "APPLIED",
          resultingRevision: 2,
        },
      ],
    ]);

    await expect(
      createJobRequestDraftRepository(harness.sql).autosaveOwned({
        actorUserId: actor,
        commandId: command,
        expectedRevision: 1,
        jobRequestId: request,
        section,
      }),
    ).rejects.toBeInstanceOf(JobRequestDraftIdempotencyError);
    expect(harness.statements[0]).toMatch(/account_state = 'ACTIVE'/u);
  });

  it("creates request, first revision and first section in one transaction", async () => {
    const harness = transactionHarness([
      [{}],
      [],
      [],
      [],
      [{ createdAt: now }],
      [],
      [],
    ]);
    const result = await createJobRequestDraftRepository(
      harness.sql,
    ).createDraftWithInitialSectionOwned({
      actorUserId: actor,
      commandId: command,
      customerProfileId: customer,
      section,
    });

    expect(result).toMatchObject({ revision: 1, status: "APPLIED" });
    expect(harness.statements.join("\n")).toContain("INSERT INTO job_requests");
    expect(harness.statements.join("\n")).toContain(
      "INSERT INTO job_request_draft_section_revisions",
    );
  });

  it("recovers only allowlisted current sections under an ACTIVE owner lock", async () => {
    const fingerprint = sha256(section.canonicalPayload);
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [{}],
      [currentDraft(3)],
      [sectionRow(fingerprint)],
    ]);

    await expect(
      createJobRequestDraftRepository(harness.sql).recoverOwned({
        actorUserId: actor,
        jobRequestId: request,
      }),
    ).resolves.toEqual({
      draft: {
        changedAt: now,
        createdAt: now,
        id: request,
        revision: 3,
        sections: [
          {
            key: section.key,
            payload: section.payload,
            savedAt: now,
            schemaVersion: 1,
          },
        ],
      },
      status: "OK",
    });
    expect(harness.statements.join("\n")).not.toMatch(
      /SELECT[^]*payload_fingerprint[^]*FROM current_job_requests/u,
    );
  });
});

function currentDraft(revision: number) {
  return {
    changedAt: now,
    createdAt: now,
    revision,
    state: "DRAFT" as const,
  };
}

function sectionRow(payloadFingerprint: string) {
  return {
    payload: section.payload,
    payloadFingerprint,
    requestRevision: 2,
    savedAt: now,
    sectionKey: section.key,
    sectionSchemaVersion: section.schemaVersion,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function transactionHarness(responses: readonly unknown[][]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const queue = [...responses];
  const statements: string[] = [];
  const transaction = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve(queue.shift() ?? []);
    }),
    {
      json: vi.fn((value: unknown) => value),
    },
  ) as unknown as Sql;
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn((work: (transaction: Sql) => Promise<unknown>) =>
      work(transaction),
    ),
  }) as unknown as Sql;
  return { sql, statements };
}
