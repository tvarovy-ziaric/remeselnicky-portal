import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createJobLocationClarificationRepository,
  type ClarifyJobLocationInput,
} from "../src/job-location-clarification-repository.js";

const valid: ClarifyJobLocationInput = {
  actorUserId: "12340000-0000-4000-8000-000000000001",
  commandId: "12340000-0000-4000-8000-000000000002",
  expectedRevision: 1,
  jobId: "12340000-0000-4000-8000-000000000003",
  location: {
    exactAddress: "Syntetická 12",
    mapPin: null,
    municipalityCode: "TEST:MUNICIPALITY_ALPHA",
    textClarification: null,
  },
  reason: "Doplnenie miesta realizácie",
};

describe("Job location clarification input", () => {
  const repository = createJobLocationClarificationRepository({} as Sql);

  it("rejects malformed identifiers, revision and reason before SQL", () => {
    for (const input of [
      { ...valid, actorUserId: "not-a-user" },
      { ...valid, commandId: "not-a-command" },
      { ...valid, jobId: "not-a-job" },
      { ...valid, expectedRevision: 0 },
      { ...valid, expectedRevision: 1.5 },
      { ...valid, reason: "short" },
    ])
      expect(() => repository.clarify(input)).toThrow(TypeError);
  });

  it("rejects malformed or unexpectedly extended private location fields", () => {
    for (const location of [
      { ...valid.location, municipalityCode: " " },
      { ...valid.location, exactAddress: " " },
      { ...valid.location, exactAddress: "x".repeat(501) },
      { ...valid.location, textClarification: "x".repeat(1001) },
      { ...valid.location, mapPin: { latitude: 91, longitude: 17 } },
      { ...valid.location, mapPin: { latitude: 48, longitude: 181 } },
      { ...valid.location, extra: "client-owned" },
    ])
      expect(() => repository.clarify({ ...valid, location })).toThrow(
        TypeError,
      );
  });
});
