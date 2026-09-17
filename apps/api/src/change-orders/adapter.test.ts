import type { createChangeOrderRepository } from "@portal/db";
import { describe, expect, it, vi } from "vitest";

import { createChangeOrderRouteAdapter } from "./adapter.js";

const actorUserId = "f2200000-0000-4000-8000-000000000001";
const jobId = "f2200000-0000-4000-8000-000000000002";
const changeOrderId = "f2200000-0000-4000-8000-000000000003";
const revisionId = "f2200000-0000-4000-8000-000000000004";
const mediaAssetId = "f2200000-0000-4000-8000-000000000005";
const at = new Date("2026-09-17T09:00:00.000Z");
const revision = {
  revisionId,
  revisionNumber: 1,
  state: "PROPOSED",
  authoredByUserId: actorUserId,
  authoredSide: "CUSTOMER",
  terms: {
    title: "Zmena",
    reason: "Dôvod",
    changeDescription: "Rozsah",
    scopeAdded: ["Nová práca"],
    scopeRemoved: [],
    scopeChanged: [],
    priceImpact: { mode: "NONE" },
    scheduleImpact: { mode: "NONE" },
    externalPdfMediaAssetId: mediaAssetId,
  },
  pdfContentSha256: "hash",
  createdAt: at,
  stateChangedAt: at,
};

describe("Change-order private adapter", () => {
  it("removes internal user and media IDs from detail, revision and history pages", async () => {
    const repository = {
      getChangeOrder: vi.fn(() =>
        Promise.resolve({
          changeOrderId,
          jobId,
          createdByUserId: actorUserId,
          createdBySide: "CUSTOMER",
          createdAt: at,
          revisions: [revision],
          actions: [
            {
              id: revisionId,
              revisionId,
              action: "PROPOSE",
              actorUserId,
              occurredAt: at,
            },
          ],
        }),
      ),
      listRevisions: vi.fn(() =>
        Promise.resolve({
          items: [revision],
          nextCursor: null,
        }),
      ),
      getRevision: vi.fn(() => Promise.resolve(revision)),
    } as unknown as ReturnType<typeof createChangeOrderRepository>;
    const adapter = createChangeOrderRouteAdapter(repository, {
      documentDownloadsEnabled: true,
    });
    const input = { actorUserId, jobId, changeOrderId };
    const detail = await adapter.get(input);
    const page = await adapter.listRevisions({ ...input, limit: 20 });
    const exact = await adapter.getRevision({ ...input, revisionId });
    for (const result of [detail, page, exact]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(actorUserId);
      expect(serialized).not.toContain("externalPdfMediaAssetId");
      expect(serialized).toContain("externalPdfDownloadPath");
      expect(serialized).toContain(`/v1/media/${mediaAssetId}/download`);
    }
  });
});
