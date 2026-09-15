import { createHash } from "node:crypto";

import {
  JobRequestVersionIdempotencyError,
  normalizeJobRequestContentSection,
  type CustomerProfileId,
  type JobRequestId,
  type UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createJobRequestVersionRepository } from "../src/job-request-version-repository.js";

const actor = "99000000-0000-4000-8000-000000000001" as UserId;
const customer = "99000000-0000-4000-8000-000000000002" as CustomerProfileId;
const request = "99000000-0000-4000-8000-000000000003" as JobRequestId;
const command = "99000000-0000-4000-8000-000000000004";
const changedAt = new Date("2026-09-15T09:30:00.000Z");

describe("active job request version repository", () => {
  it("appends a material version and one exact section effect", async () => {
    const previous = core({ description: "Oprava strechy" });
    const next = core({ description: "Výmena celej strechy" });
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [versionRow(1, 1, [], false)],
      [sectionRow(previous)],
      [],
      [],
      [],
      [versionRow(2, 2, ["SCOPE"], true)],
    ]);

    await expect(
      createJobRequestVersionRepository(harness.sql).reviseActiveOwned({
        actorUserId: actor,
        commandId: command,
        expectedContentRevision: 1,
        jobRequestId: request,
        section: next,
      }),
    ).resolves.toMatchObject({
      status: "APPLIED",
      version: {
        categories: ["SCOPE"],
        contentRevision: 2,
        material: true,
        visibleVersion: 2,
      },
    });
    const statements = harness.statements.join("\n");
    expect(statements).toContain(
      "INSERT INTO job_request_active_edit_commands",
    );
    expect(statements).toContain(
      "INSERT INTO job_request_active_content_revisions",
    );
    expect(statements).toContain(
      "INSERT INTO job_request_active_section_revisions",
    );
  });

  it("keeps a title-only edit within the same visible version", async () => {
    const previous = core({ title: "Strecha" });
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [versionRow(2, 4, ["SCOPE"], true)],
      [sectionRow(previous)],
      [],
      [],
      [],
      [versionRow(3, 4, [], false)],
    ]);

    await expect(
      createJobRequestVersionRepository(harness.sql).reviseActiveOwned({
        actorUserId: actor,
        commandId: command,
        expectedContentRevision: 2,
        jobRequestId: request,
        section: core({ title: "Oprava strechy" }),
      }),
    ).resolves.toMatchObject({
      status: "APPLIED",
      version: { contentRevision: 3, material: false, visibleVersion: 4 },
    });
  });

  it("durably records unchanged intent without revision effects", async () => {
    const section = core({ description: "Oprava strechy" });
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [versionRow(3, 2, ["SCOPE"], true)],
      [sectionRow(section)],
      [],
      [versionRow(3, 2, ["SCOPE"], true)],
    ]);

    await expect(
      createJobRequestVersionRepository(harness.sql).reviseActiveOwned({
        actorUserId: actor,
        commandId: command,
        expectedContentRevision: 3,
        jobRequestId: request,
        section,
      }),
    ).resolves.toMatchObject({ status: "UNCHANGED" });
    expect(harness.statements.join("\n")).not.toContain(
      "INSERT INTO job_request_active_section_revisions",
    );
  });

  it("returns the authoritative revision on a stale competing command", async () => {
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [],
      [{}],
      [versionRow(4, 3, ["LOCATION"], true)],
    ]);
    await expect(
      createJobRequestVersionRepository(harness.sql).reviseActiveOwned({
        actorUserId: actor,
        commandId: command,
        expectedContentRevision: 3,
        jobRequestId: request,
        section: core(),
      }),
    ).resolves.toEqual({
      currentContentRevision: 4,
      status: "STALE_REVISION",
    });
  });

  it("reauthorizes before replay and rejects command collisions", async () => {
    const section = core();
    const harness = transactionHarness([
      [],
      [{ customerProfileId: customer }],
      [],
      [
        {
          actorUserId: actor,
          customerProfileId: customer,
          intentFingerprint: "0".repeat(64),
          jobRequestId: request,
          resultKind: "UNCHANGED",
          resultingContentRevision: 1,
          sectionKey: section.key,
          sectionPayloadFingerprint: sha256(section.canonicalPayload),
          sectionSchemaVersion: 1,
        },
      ],
    ]);
    await expect(
      createJobRequestVersionRepository(harness.sql).reviseActiveOwned({
        actorUserId: actor,
        commandId: command,
        expectedContentRevision: 1,
        jobRequestId: request,
        section,
      }),
    ).rejects.toBeInstanceOf(JobRequestVersionIdempotencyError);
    expect(harness.statements[0]).toContain("41007");
    expect(harness.statements[1]).toMatch(/account_state = 'ACTIVE'/u);
  });

  it("reads an exact historical snapshot under the owner lock", async () => {
    const section = core({ description: "Pôvodný rozsah" });
    const harness = transactionHarness([
      [{ customerProfileId: customer }],
      [{}],
      [versionRow(1, 1, [], false)],
      [sectionRow(section)],
    ]);
    await expect(
      createJobRequestVersionRepository(harness.sql).readActiveOwned({
        actorUserId: actor,
        contentRevision: 1,
        jobRequestId: request,
      }),
    ).resolves.toMatchObject({
      snapshot: {
        sections: [
          { key: "request.core", payload: { description: "Pôvodný rozsah" } },
        ],
        version: { contentRevision: 1, visibleVersion: 1 },
      },
      status: "OK",
    });
  });
});

function core(overrides: Record<string, unknown> = {}) {
  return normalizeJobRequestContentSection({
    key: "request.core",
    payload: {
      description: null,
      primaryProfessionCode: null,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: null,
      ...overrides,
    },
    schemaVersion: 1,
  });
}

function versionRow(
  contentRevision: number,
  visibleVersion: number,
  categories: string[],
  material: boolean,
) {
  return {
    categories,
    changedAt,
    contentRevision,
    jobRequestId: request,
    material,
    sourceRequestRevision: 3,
    visibleVersion,
  };
}

function sectionRow(section: ReturnType<typeof core>) {
  return {
    payload: section.payload,
    payloadFingerprint: sha256(section.canonicalPayload),
    sectionKey: section.key,
    sectionSchemaVersion: section.schemaVersion,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    { json: vi.fn((value: unknown) => value) },
  ) as unknown as Sql;
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn((work: (transaction: Sql) => Promise<unknown>) =>
      work(transaction),
    ),
  }) as unknown as Sql;
  return { sql, statements };
}
