import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobDocumentationRepository } from "../src/job-documentation-repository.js";

const actorUserId = "86200000-0000-4000-8000-000000000001";
const jobId = "86200000-0000-4000-8000-000000000004";
const imageId = "86200000-0000-4000-8000-000000000006";
const documentId = "86200000-0000-4000-8000-000000000007";
const extraId = "86200000-0000-4000-8000-000000000008";
const messageId = "86200000-0000-4000-8000-000000000009";
const timestamp = new Date("2026-09-16T18:00:00.000Z");

function row(mediaAssetId: string, mediaKind: "IMAGE" | "DOCUMENT") {
  return {
    mediaAssetId,
    mediaKind,
    sourceMessageId: messageId,
    uploadedByUserId: actorUserId,
    uploadedAt: timestamp,
    capturedAt: mediaKind === "IMAGE" ? timestamp : null,
    chronologicalAt: timestamp,
    displayFilename: mediaKind === "IMAGE" ? "priebeh.jpg" : "doklad.pdf",
    contentType: mediaKind === "IMAGE" ? "image/webp" : "application/pdf",
  };
}

describe("primary-party Job documentation read model", () => {
  it("intersects exact Job authorization, private canonical media and stable chronology", async () => {
    const fixture = fakeSql([
      [{ id: jobId, customerUserId: actorUserId, providerUserId: extraId }],
      [
        row(imageId, "IMAGE"),
        row(documentId, "DOCUMENT"),
        row(extraId, "IMAGE"),
      ],
    ]);
    const page = await createJobDocumentationRepository(
      fixture.sql,
    ).listForPrimaryParty({
      actorUserId,
      category: "ALL",
      jobId,
      limit: 2,
    });
    expect(page?.items.map((item) => item.kind)).toEqual(["PHOTO", "DOCUMENT"]);
    expect(page?.items[0]).toMatchObject({
      source: "WINNING_CONVERSATION",
      sourceMessageId: messageId,
      uploadedByUserId: actorUserId,
      authorRole: "CUSTOMER",
      downloadPath: `/v1/media/${imageId}/download`,
    });
    expect(page?.nextCursor).toEqual({
      chronologicalAt: timestamp,
      mediaAssetId: documentId,
    });
    expect(fixture.statements[0]).toContain("viewer.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain("FOR SHARE OF viewer");
    expect(fixture.statements[1]).toContain("job_conversation_media");
    expect(fixture.statements[1]).toContain("malware_scan_verdict = 'CLEAN'");
    expect(fixture.statements[1]).toContain(
      "canonical.storage_area = 'private'",
    );
    expect(fixture.statements[1]).toContain(
      "ORDER BY media.chronological_at DESC",
    );
  });

  it("returns the same null for unknown and unrelated Jobs without reading media", async () => {
    const fixture = fakeSql([[]]);
    const page = await createJobDocumentationRepository(
      fixture.sql,
    ).listForPrimaryParty({
      actorUserId,
      category: "PHOTO",
      jobId,
      limit: 20,
    });
    expect(page).toBeNull();
    expect(fixture.statements).toHaveLength(1);
  });

  it("rejects unbounded queries and fails closed on corrupt provenance", async () => {
    const repository = createJobDocumentationRepository(fakeSql([]).sql);
    await expect(
      repository.listForPrimaryParty({
        actorUserId,
        category: "ALL",
        jobId,
        limit: 51,
      }),
    ).rejects.toThrow("Invalid Job documentation query");
    const corrupt = fakeSql([
      [{ id: jobId, customerUserId: actorUserId, providerUserId: extraId }],
      [{ ...row(imageId, "IMAGE"), sourceMessageId: "bad" }],
    ]);
    await expect(
      createJobDocumentationRepository(corrupt.sql).listForPrimaryParty({
        actorUserId,
        category: "PHOTO",
        jobId,
        limit: 20,
      }),
    ).rejects.toThrow("Invalid Job documentation provenance");
  });
});

function fakeSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  const tagged = (parts: TemplateStringsArray): Promise<readonly unknown[]> => {
    statements.push(parts.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  };
  const sql = Object.assign(tagged, {
    begin: (callback: (transaction: Sql) => Promise<unknown>) => callback(sql),
  }) as unknown as Sql;
  return { sql, statements };
}
