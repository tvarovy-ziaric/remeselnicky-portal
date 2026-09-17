import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createJobOperationalRepository } from "../src/job-operational-repository.js";

const id = () => randomUUID();
const repository = createJobOperationalRepository({} as Sql);

describe("Job operational repository input boundary", () => {
  it("rejects invalid identity, body, issue kind and control characters before SQL", async () => {
    await expect(
      repository.createProgress({
        actorUserId: "invalid",
        commandId: id(),
        jobId: id(),
        body: "Práce pokračujú.",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createProgress({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        body: "",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createIssue({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        body: "problém",
        kind: "PROBLEM",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createIssue({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        body: "Materiál mešká",
        kind: "OTHER" as "PROBLEM",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.addIssueComment({
        actorUserId: id(),
        commandId: id(),
        jobId: id(),
        issueId: id(),
        body: "text\nnový riadok",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("bounds cursors, pages and single-item identifiers", async () => {
    await expect(
      repository.listProgress({ actorUserId: id(), jobId: id(), limit: 51 }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listIssues({ actorUserId: id(), jobId: id(), limit: 0 }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listIssueComments({
        actorUserId: id(),
        jobId: id(),
        issueId: id(),
        limit: 1,
        cursor: { id: id(), createdAt: new Date(Number.NaN) },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.getProgress({ actorUserId: id(), jobId: id(), updateId: "x" }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.getIssue({ actorUserId: id(), jobId: id(), issueId: "x" }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects malformed, repeated and over-limit media selections before SQL", async () => {
    const common = {
      actorUserId: id(),
      commandId: id(),
      jobId: id(),
      body: "Práce pokračujú podľa plánu.",
    };
    await expect(
      repository.createProgress({ ...common, mediaAssetIds: ["not-a-uuid"] }),
    ).rejects.toThrow(TypeError);
    const mediaId = id();
    await expect(
      repository.createProgress({
        ...common,
        mediaAssetIds: [mediaId, mediaId],
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createIssue({
        ...common,
        kind: "PROBLEM",
        mediaAssetIds: Array.from({ length: 6 }, id),
      }),
    ).rejects.toThrow(TypeError);
  });
});
