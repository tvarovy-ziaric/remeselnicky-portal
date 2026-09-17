import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createChangeOrderRepository,
  type ChangeOrderTerms,
} from "../src/change-order-repository.js";

const id = () => randomUUID();
const repository = createChangeOrderRepository({} as Sql);
const terms: ChangeOrderTerms = {
  title: "Zmena rozsahu",
  reason: "Po obhliadke",
  changeDescription: "Nové práce",
  scopeAdded: ["Oprava podkladu"],
  scopeRemoved: [],
  scopeChanged: [],
  priceImpact: { mode: "NONE" },
  scheduleImpact: { mode: "NONE" },
};
const create = () => ({
  actorUserId: id(),
  commandId: id(),
  jobId: id(),
  revisionId: id(),
  terms,
});

describe("Change-order input boundary", () => {
  it("rejects malformed identities, no-op and unsafe text before SQL", async () => {
    await expect(
      repository.createDraft({ ...create(), jobId: "bad" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createDraft({
        ...create(),
        terms: { ...terms, scopeAdded: [], title: "x\ny" },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createDraft({
        ...create(),
        terms: { ...terms, scopeAdded: [] },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("enforces signed EUR cents, VAT, estimates and ranges", async () => {
    await expect(
      repository.createDraft({
        ...create(),
        terms: {
          ...terms,
          priceImpact: {
            mode: "FIXED_DELTA",
            amountCents: 0,
            vatStatus: "VAT_INCLUDED",
          },
        },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createDraft({
        ...create(),
        terms: {
          ...terms,
          priceImpact: {
            mode: "FIXED_DELTA",
            amountCents: Number.MAX_SAFE_INTEGER,
            vatStatus: "VAT_INCLUDED",
          },
        },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createDraft({
        ...create(),
        terms: {
          ...terms,
          priceImpact: {
            mode: "RANGE_DELTA",
            minimumCents: 2000,
            maximumCents: 1000,
            basis: "Od rozsahu",
            vatStatus: "VAT_EXCLUDED",
          },
        },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects invalid schedule and duplicate milestone references", async () => {
    await expect(
      repository.createDraft({
        ...create(),
        terms: {
          ...terms,
          scheduleImpact: { mode: "DATE", newDate: "2026-02-30" },
        },
      }),
    ).rejects.toThrow(TypeError);
    const milestoneId = id();
    await expect(
      repository.createDraft({
        ...create(),
        terms: { ...terms, affectedMilestoneIds: [milestoneId, milestoneId] },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("bounds read pagination and exact revision identity", async () => {
    await expect(
      repository.listChangeOrders({
        actorUserId: id(),
        jobId: id(),
        limit: 101,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listRevisions({
        actorUserId: id(),
        jobId: id(),
        changeOrderId: id(),
        beforeRevisionNumber: 0,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.getRevision({
        actorUserId: id(),
        jobId: id(),
        changeOrderId: id(),
      }),
    ).rejects.toThrow(TypeError);
  });
});
