import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobMilestoneContextRepository } from "../src/job-milestone-context-repository.js";

const id = () => randomUUID();
const repository = createJobMilestoneContextRepository({} as Sql);

describe("milestone context input boundary", () => {
  it("rejects invalid proposal identity, text and dates before SQL", async () => {
    await expect(
      repository.createProposal({
        actorUserId: "bad",
        commandId: id(),
        jobId: id(),
        title: "Návrh",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createProposal({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: " ",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createProposal({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: "Návrh\n",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createProposal({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: "Návrh",
        plannedStartOn: "2026-02-30",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createProposal({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: "Návrh",
        plannedStartOn: "2026-09-20",
        plannedEndOn: "2026-09-19",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects malformed decisions, comments and media identifiers", async () => {
    await expect(
      repository.decideProposal({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        proposalId: id(),
        decision: "PAY" as "ACCEPT",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.addComment({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        milestoneId: id(),
        body: "\n",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.linkMedia({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        milestoneId: id(),
        mediaAssetId: "bad",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("bounds private pages and cursors", async () => {
    await expect(
      repository.listProposals({ actorUserId: id(), jobId: id(), limit: 51 }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listComments({
        actorUserId: id(),
        jobId: id(),
        milestoneId: id(),
        limit: 1,
        cursor: { createdAt: new Date(Number.NaN), id: id() },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listMedia({
        actorUserId: id(),
        jobId: id(),
        milestoneId: "bad",
        limit: 1,
      }),
    ).rejects.toThrow(TypeError);
  });
});
