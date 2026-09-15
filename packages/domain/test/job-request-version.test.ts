import { describe, expect, it } from "vitest";

import {
  classifyJobRequestChange,
  createJobRequestVersionService,
  type JobRequestId,
  type UserId,
} from "../src/index.js";

describe("job request version classification", () => {
  it("keeps an isolated title correction minor", () => {
    expect(
      classifyJobRequestChange(
        core({ title: "Stará strecha" }),
        core({ title: "Oprava strechy" }),
      ),
    ).toEqual({ categories: [], changed: true, material: false });
  });

  it("classifies price-or-willingness changes conservatively and deterministically", () => {
    expect(
      classifyJobRequestChange(
        core({
          description: "Opraviť strechu",
          primaryProfessionCode: "PROF:ROOFER",
        }),
        core({
          description: "Vymeniť celú strechu",
          primaryProfessionCode: "PROF:CARPENTER",
        }),
      ),
    ).toEqual({
      categories: ["PROFESSION", "SCOPE"],
      changed: true,
      material: true,
    });
    expect(
      classifyJobRequestChange(
        section("request.location", {
          exactAddress: null,
          mapPin: null,
          municipalityCode: "SK:BA:BRATISLAVA",
          textClarification: null,
        }),
        section("request.location", {
          exactAddress: null,
          mapPin: null,
          municipalityCode: "SK:TT:TRNAVA",
          textClarification: null,
        }),
      ).categories,
    ).toEqual(["LOCATION"]);
  });

  it("recognizes exact normalized replay and rejects cross-section comparison", () => {
    const input = core({ description: "  Opraviť strechu  " });
    expect(
      classifyJobRequestChange(input, core({ description: "Opraviť strechu" })),
    ).toEqual({
      categories: [],
      changed: false,
      material: false,
    });
    expect(() =>
      classifyJobRequestChange(
        input,
        section("request.media", {
          documentMediaAssetIds: [],
          photoMediaAssetIds: [],
        }),
      ),
    ).toThrow(/same section/u);
  });

  it("normalizes the server command before persistence", async () => {
    let persisted: unknown;
    const service = createJobRequestVersionService({
      persistence: {
        reviseActiveOwned(input) {
          persisted = input;
          return Promise.resolve({
            status: "UNCHANGED",
            version: {
              categories: [],
              changedAt: new Date("2026-09-15T08:00:00Z"),
              contentRevision: 2,
              jobRequestId: input.jobRequestId,
              material: false,
              visibleVersion: 1,
            },
          });
        },
      },
    });
    await service.reviseActive({
      actorUserId: "95000000-0000-4000-8000-000000000001" as UserId,
      commandId: "95000000-0000-4000-8000-000000000002",
      expectedContentRevision: 2,
      jobRequestId: "95000000-0000-4000-8000-000000000003" as JobRequestId,
      section: core({ description: "  Opraviť strechu  " }),
    });
    expect(persisted).toMatchObject({
      section: {
        payload: { description: "Opraviť strechu" },
      },
    });
  });
});

function core(
  overrides: Partial<{
    description: string | null;
    primaryProfessionCode: string | null;
    title: string | null;
  }> = {},
) {
  return section("request.core", {
    description: null,
    primaryProfessionCode: null,
    relatedProfessionCodes: [],
    skillCodes: [],
    specializationCode: null,
    title: null,
    ...overrides,
  });
}

function section(key: string, payload: unknown) {
  return { key, payload, schemaVersion: 1 };
}
