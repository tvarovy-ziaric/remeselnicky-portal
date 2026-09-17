import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createChangeOrderPdfUploadRepository } from "../src/change-order-pdf-upload-repository.js";

const id = () => randomUUID();
const input = () => ({
  actorUserId: id(),
  jobId: id(),
  revisionId: id(),
  mediaAssetId: id(),
});

describe("Change-order PDF status boundary", () => {
  it("keeps expired exact owner asset visible but ineligible", async () => {
    const expiresAt = new Date("2020-01-01T00:00:00.000Z");
    const query = (() =>
      Promise.resolve([
        {
          status: "READY",
          expiresAt,
          jobOpen: true,
          headValid: true,
          revisionAbsent: true,
          canonicalReady: true,
        },
      ])) as unknown as Sql;
    const result =
      await createChangeOrderPdfUploadRepository(query).readStatus(input());
    expect(result).toEqual({
      status: "READY",
      expiresAt,
      canCreateRevision: false,
    });
  });

  it("does not disclose an unrelated asset", async () => {
    const query = (() => Promise.resolve([])) as unknown as Sql;
    expect(
      await createChangeOrderPdfUploadRepository(query).readStatus(input()),
    ).toBeNull();
  });
});
