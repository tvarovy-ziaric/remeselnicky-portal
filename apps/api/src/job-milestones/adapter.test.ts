import type { createJobMilestoneRepository } from "@portal/db";
import { describe, expect, it, vi } from "vitest";

import { createJobMilestoneRouteAdapter } from "./adapter.js";

const jobId = "86220000-0000-4000-8000-000000000001";
const milestoneId = "86220000-0000-4000-8000-000000000002";
const actorUserId = "86220000-0000-4000-8000-000000000003";
const commandId = "86220000-0000-4000-8000-000000000004";
const mediaAssetId = "86220000-0000-4000-8000-000000000005";
const at = new Date("2026-09-17T08:00:00.000Z");

describe("Job milestone transport adapter", () => {
  it("serializes only a private authorized media path and ordered cursor", async () => {
    const record = {
      id: milestoneId,
      jobId,
      title: "Etapa 1",
      description: null,
      state: "PLANNED" as const,
      orderIndex: 0,
      originalPlannedStartOn: null,
      originalPlannedEndOn: null,
      currentPlannedStartOn: null,
      currentPlannedEndOn: null,
      acceptedStageLabel: "Etapa v prijatej ponuke",
      sourceQuoteId: "86220000-0000-4000-8000-000000000006",
      sourceQuoteRevision: 1,
      sourcePdfMediaAssetId: mediaAssetId,
      responsibility: null,
      createdAt: at,
      updatedAt: at,
      acknowledgedAt: null,
      capabilities: {
        canEdit: true,
        canSetState: true,
        canMarkDone: true,
        canReorder: true,
        canAssign: true,
        canAcknowledge: false,
      },
    };
    const persistence = {
      listMilestones: vi.fn(() =>
        Promise.resolve({
          items: [record],
          canCreate: true,
          nextCursor: { afterOrder: 0, afterId: milestoneId },
        }),
      ),
      getMilestone: vi.fn(() => Promise.resolve(record)),
      listMilestoneHistory: vi.fn(() =>
        Promise.resolve([
          {
            eventId: commandId,
            sequence: 3,
            kind: "CREATE" as const,
            actorUserId,
            title: record.title,
            description: null,
            plannedStartOn: null,
            plannedEndOn: null,
            state: "PLANNED" as const,
            orderKey: "1.00000000000000000000",
            responsibility: null,
            acceptedStageLabel: record.acceptedStageLabel,
            sourceQuoteId: record.sourceQuoteId,
            sourceQuoteRevision: 1,
            sourcePdfMediaAssetId: mediaAssetId,
            recordedAt: at,
          },
          {
            eventId: "86220000-0000-4000-8000-000000000007",
            sequence: 2,
            kind: "EDIT" as const,
            actorUserId,
            title: record.title,
            description: null,
            plannedStartOn: null,
            plannedEndOn: null,
            state: "PLANNED" as const,
            orderKey: "1.00000000000000000000",
            responsibility: null,
            acceptedStageLabel: record.acceptedStageLabel,
            sourceQuoteId: record.sourceQuoteId,
            sourceQuoteRevision: 1,
            sourcePdfMediaAssetId: null,
            recordedAt: at,
          },
        ]),
      ),
      createMilestone: vi.fn(() =>
        Promise.resolve({ status: "APPLIED", id: milestoneId, updatedAt: at }),
      ),
      acknowledgeMilestone: vi.fn(() =>
        Promise.resolve({ status: "APPLIED", acknowledgedAt: at }),
      ),
    } as unknown as ReturnType<typeof createJobMilestoneRepository>;
    const adapter = createJobMilestoneRouteAdapter(persistence);
    const page = await adapter.list({ actorUserId, jobId, limit: 20 });
    expect(page).not.toBeNull();
    expect(page?.nextCursor).toEqual({ orderIndex: 0, id: milestoneId });
    expect(page?.items[0]).toMatchObject({
      sourcePdfDownloadPath: `/v1/media/${mediaAssetId}/download`,
    });
    expect(page?.items[0]).not.toHaveProperty("sourcePdfMediaAssetId");
    expect((await adapter.get({ actorUserId, jobId, milestoneId }))?.id).toBe(
      milestoneId,
    );
    const history = await adapter.listHistory({
      actorUserId,
      jobId,
      milestoneId,
      limit: 1,
    });
    expect(history?.nextCursor).toBe(3);
    expect(history?.items[0]).toMatchObject({
      sourcePdfDownloadPath: `/v1/media/${mediaAssetId}/download`,
      orderKey: "1.00000000000000000000",
    });
    expect(history?.items[0]).not.toHaveProperty("sourcePdfMediaAssetId");
    expect(persistence.listMilestoneHistory).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      milestoneId,
      limit: 2,
    });
    expect(
      await adapter.create({
        actorUserId,
        jobId,
        commandId,
        title: "Etapa 1",
      }),
    ).toEqual({ status: "APPLIED", milestoneId });
    expect(
      await adapter.acknowledge({
        actorUserId,
        jobId,
        milestoneId,
        commandId,
      }),
    ).toEqual({ status: "APPLIED", milestoneId });
  });
});
