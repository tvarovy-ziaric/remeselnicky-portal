import type {
  createJobMilestoneRepository,
  JobMilestoneHistoryEvent,
  JobMilestoneItem,
} from "@portal/db";

import type { JobMilestoneRouteDependencies } from "./routes.js";

type Persistence = ReturnType<typeof createJobMilestoneRepository>;
type Transport = JobMilestoneRouteDependencies["milestones"];

function item(record: JobMilestoneItem) {
  const { sourcePdfMediaAssetId, ...rest } = record;
  return {
    ...rest,
    sourcePdfDownloadPath:
      sourcePdfMediaAssetId === null
        ? null
        : `/v1/media/${sourcePdfMediaAssetId}/download`,
  };
}

function historyEvent(record: JobMilestoneHistoryEvent) {
  const { sourcePdfMediaAssetId, ...rest } = record;
  return {
    ...rest,
    sourcePdfDownloadPath:
      sourcePdfMediaAssetId === null
        ? null
        : `/v1/media/${sourcePdfMediaAssetId}/download`,
  };
}

function command(result: Awaited<ReturnType<Persistence["createMilestone"]>>) {
  return result.status === "APPLIED" || result.status === "DEDUPLICATED"
    ? { status: result.status, milestoneId: result.id }
    : { status: result.status };
}

export function createJobMilestoneRouteAdapter(
  persistence: Persistence,
): Transport {
  return Object.freeze({
    async list(input) {
      const page = await persistence.listMilestones({
        actorUserId: input.actorUserId,
        jobId: input.jobId,
        limit: input.limit,
        ...(input.cursor === undefined
          ? {}
          : {
              cursor: {
                afterOrder: input.cursor.orderIndex,
                afterId: input.cursor.id,
              },
            }),
      });
      if (page === null) return null;
      return {
        items: page.items.map(item),
        canCreate: page.canCreate,
        nextCursor:
          page.nextCursor === null
            ? null
            : {
                orderIndex: page.nextCursor.afterOrder,
                id: page.nextCursor.afterId,
              },
      };
    },
    async get(input) {
      const record = await persistence.getMilestone(input);
      return record === null ? null : item(record);
    },
    async listHistory(input) {
      const rows = await persistence.listMilestoneHistory({
        ...input,
        limit: input.limit + 1,
      });
      if (rows === null) return null;
      const page = rows.slice(0, input.limit);
      return {
        items: page.map(historyEvent),
        nextCursor:
          rows.length > input.limit ? (page.at(-1)?.sequence ?? null) : null,
      };
    },
    async create(input) {
      return command(await persistence.createMilestone(input));
    },
    async edit(input) {
      return command(
        await persistence.editMilestone({
          ...input,
          description: input.description ?? null,
          plannedStartOn: input.plannedStartOn ?? null,
          plannedEndOn: input.plannedEndOn ?? null,
        }),
      );
    },
    async setState(input) {
      return command(await persistence.setMilestoneState(input));
    },
    async reorder(input) {
      return command(await persistence.reorderMilestone(input));
    },
    async assign(input) {
      return command(await persistence.assignMilestone(input));
    },
    async acknowledge(input) {
      const result = await persistence.acknowledgeMilestone(input);
      return result.status === "APPLIED" || result.status === "DEDUPLICATED"
        ? { status: result.status, milestoneId: input.milestoneId }
        : { status: result.status };
    },
  });
}
