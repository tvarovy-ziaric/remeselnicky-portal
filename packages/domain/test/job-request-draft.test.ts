import { describe, expect, it, vi } from "vitest";

import {
  createJobRequestDraftService,
  JOB_REQUEST_DRAFT_MAX_ARRAY_LENGTH,
  normalizeAutosaveJobRequestDraftInput,
  type PersistAutosaveJobRequestDraftInput,
} from "../src/job-request-draft.js";
import type { JobRequestId } from "../src/job-request.js";
import type { UserId } from "../src/user.js";

const actor = "97000000-0000-4000-8000-000000000001" as UserId;
const request = "97000000-0000-4000-8000-000000000002" as JobRequestId;
const commandId = "97000000-0000-4000-8000-000000000003";

describe("JobRequest draft autosave", () => {
  it("canonicalizes key-order equivalent object payloads identically", () => {
    const first = normalize({ nested: { z: 2, a: 1 }, answer: true });
    const second = normalize({ answer: true, nested: { a: 1, z: 2 } });
    expect(first.section.canonicalPayload).toBe(
      second.section.canonicalPayload,
    );
  });

  it("uses locale-independent code-point key order", () => {
    const normalized = normalize({ á: 5, a: 4, _: 3, A: 2, "-": 1 });
    expect(normalized.section.canonicalPayload).toBe(
      '{"-":1,"A":2,"_":3,"a":4,"á":5}',
    );
  });

  it("accepts a near-32 KiB canonical section and rejects larger content", () => {
    expect(() =>
      normalize({
        a: "x".repeat(8183),
        b: "x".repeat(8183),
        c: "x".repeat(8183),
        d: "x".repeat(8183),
      }),
    ).not.toThrow();
    expect(() =>
      normalize({
        a: "x".repeat(7000),
        b: "x".repeat(7000),
        c: "x".repeat(7000),
        d: "x".repeat(7000),
        e: "x".repeat(7000),
      }),
    ).toThrow(/payloadBytes/u);
  });

  it("passes only normalized private envelopes to persistence", async () => {
    const saved: PersistAutosaveJobRequestDraftInput[] = [];
    const autosaveOwned = vi.fn(
      (input: PersistAutosaveJobRequestDraftInput) => {
        saved.push(input);
        return Promise.resolve({
          jobRequestId: request,
          revision: 2,
          savedAt: new Date("2026-09-15T12:00:00Z"),
          status: "APPLIED" as const,
        });
      },
    );
    const service = createJobRequestDraftService({
      persistence: {
        autosaveOwned,
        createDraftWithInitialSectionOwned: vi.fn(),
        listRecentOwned: vi.fn(),
        recoverOwned: vi.fn(),
      },
    });
    await service.autosave(command({ note: "lightweight" }));
    expect(autosaveOwned).toHaveBeenCalledOnce();
    expect(saved[0]?.section).toMatchObject({
      canonicalPayload: '{"note":"lightweight"}',
      key: "form.main",
      schemaVersion: 1,
    });
  });

  it("rejects non-object, non-finite, prototype, depth and array abuse", () => {
    expect(() => normalizeAutosaveJobRequestDraftInput(command([]))).toThrow();
    expect(() =>
      normalizeAutosaveJobRequestDraftInput(command({ amount: Infinity })),
    ).toThrow(/numericValue/u);
    expect(() =>
      normalizeAutosaveJobRequestDraftInput(
        command(Object.assign(Object.create({ inherited: true }), { ok: 1 })),
      ),
    ).toThrow(/payload/u);
    expect(() =>
      normalizeAutosaveJobRequestDraftInput(
        command({
          items: Array.from({ length: JOB_REQUEST_DRAFT_MAX_ARRAY_LENGTH + 1 }),
        }),
      ),
    ).toThrow(/arrayLength/u);
    let nested: unknown = "value";
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    expect(() =>
      normalizeAutosaveJobRequestDraftInput(command({ nested })),
    ).toThrow(/depth/u);
  });
});

function command(payload: unknown) {
  return {
    actorUserId: actor,
    commandId,
    expectedRevision: 1,
    jobRequestId: request,
    section: { key: "form.main", payload, schemaVersion: 1 },
  };
}

function normalize(payload: unknown) {
  return normalizeAutosaveJobRequestDraftInput(command(payload));
}
