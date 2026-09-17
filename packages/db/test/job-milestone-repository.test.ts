import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobMilestoneRepository } from "../src/job-milestone-repository.js";

const id = () => randomUUID();
const repository = createJobMilestoneRepository({} as Sql);

describe("Job milestone input boundary", () => {
  it("rejects invalid identities and unsafe text before SQL", async () => {
    await expect(
      repository.createMilestone({
        actorUserId: "bad",
        commandId: id(),
        jobId: id(),
        title: "Fáza",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createMilestone({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: "",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createMilestone({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: "Fáza\nA",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createMilestone({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        title: "Fáza",
        acceptedStageLabel: " x ",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects invalid dates, reversed range and responsibility", async () => {
    const base = {
      actorUserId: id(),
      commandId: id(),
      jobId: id(),
      title: "Príprava",
    };
    await expect(
      repository.createMilestone({ ...base, plannedStartOn: "2026-02-30" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createMilestone({
        ...base,
        plannedStartOn: "2026-09-19",
        plannedEndOn: "2026-09-18",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createMilestone({
        ...base,
        responsibility: { kind: "PARTICIPANT", id: "bad" },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("bounds list and history pagination", async () => {
    await expect(
      repository.listMilestones({ actorUserId: id(), jobId: id(), limit: 21 }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listMilestones({
        actorUserId: id(),
        jobId: id(),
        limit: 1,
        cursor: { afterOrder: -1, afterId: id() },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listMilestoneHistory({
        actorUserId: id(),
        jobId: id(),
        milestoneId: id(),
        limit: 51,
      }),
    ).rejects.toThrow(TypeError);
    expect(() =>
      repository.setMilestoneState({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        milestoneId: id(),
        state: "PAID" as "DONE",
      }),
    ).toThrow(TypeError);
  });
});
