import { describe, expect, it, vi } from "vitest";

import {
  createTaxonomyAutocompleteService,
  TaxonomyAutocompleteIntegrityError,
  type TaxonomyAutocompleteCandidate,
  type TaxonomyAutocompletePersistence,
} from "../src/index.js";

describe("taxonomy autocomplete service", () => {
  it("orders canonical matches before aliases and deterministically deduplicates", async () => {
    const persistence = repository([
      candidate({
        code: "SPEC:TILING",
        kind: "SPECIALIZATION",
        label: "Obkladanie",
        matchedBy: "EXACT_CANONICAL",
      }),
      candidate({
        code: "PROF:MASON",
        kind: "PROFESSION",
        label: "Murár",
        matchedBy: "EXACT_ALIAS",
        professionCodes: ["PROF:MASON"],
      }),
      candidate({
        code: "PROF:TILER",
        kind: "PROFESSION",
        label: "Obkladač",
        matchedBy: "EXACT_CANONICAL",
      }),
      candidate({
        code: "PROF:TILER",
        kind: "PROFESSION",
        label: "Obkladač",
        matchedBy: "KEYWORD_ALIAS",
      }),
      candidate({
        code: "SKILL:LARGE_FORMAT",
        kind: "SKILL",
        label: "Veľkoformátové obklady",
        matchedBy: "PREFIX_CANONICAL",
      }),
    ]);
    const service = createTaxonomyAutocompleteService(persistence);

    await expect(
      service.autocomplete({
        limit: 3,
        query: "OBKLADAČ",
        scope: "CAPABILITY",
      }),
    ).resolves.toEqual({
      status: "OK",
      suggestions: [
        {
          code: "PROF:TILER",
          kind: "PROFESSION",
          label: "Obkladač",
          memberCount: 0,
          matchedBy: "EXACT_CANONICAL",
          professionCodes: ["PROF:TILER"],
          routingProfessionCode: "PROF:TILER",
        },
        {
          code: "SPEC:TILING",
          kind: "SPECIALIZATION",
          label: "Obkladanie",
          memberCount: 0,
          matchedBy: "EXACT_CANONICAL",
          professionCodes: ["PROF:TILER"],
        },
        {
          code: "SKILL:LARGE_FORMAT",
          kind: "SKILL",
          label: "Veľkoformátové obklady",
          memberCount: 0,
          matchedBy: "PREFIX_CANONICAL",
          professionCodes: ["PROF:TILER"],
        },
      ],
    });
    expect(persistence.findCandidates.mock.calls).toEqual([
      [
        {
          limit: 3,
          normalizedText: "obkladac",
          scope: "CAPABILITY",
          tokens: ["obkladac"],
        },
      ],
    ]);
  });

  it("does not query persistence or echo an invalid raw query", async () => {
    const persistence = repository([]);
    await expect(
      createTaxonomyAutocompleteService(persistence).autocomplete({
        query: "private@example.test\nsecret",
      }),
    ).resolves.toEqual({ status: "INVALID_QUERY" });
    expect(persistence.findCandidates.mock.calls).toEqual([]);
  });

  it("accepts the reserved synthetic namespace only through governed candidates", async () => {
    const synthetic = candidate({
      code: "TEST:PROFESSION_A",
      professionCodes: ["TEST:PROFESSION_A"],
    });
    await expect(
      createTaxonomyAutocompleteService(repository([synthetic])).autocomplete({
        query: "synteticka profesia",
      }),
    ).resolves.toMatchObject({
      status: "OK",
      suggestions: [
        {
          code: "TEST:PROFESSION_A",
          professionCodes: ["TEST:PROFESSION_A"],
        },
      ],
    });
  });

  it.each([
    { activated: false },
    { contentClass: "PLACEHOLDER" },
    { reviewState: "HUMAN_REVIEW_PENDING" },
    { entryState: "DEPRECATED" },
  ])("fails closed for non-current governance: %j", async (governance) => {
    const invalid = candidate({
      governance: { ...activeGovernance, ...governance },
    });
    await expect(
      createTaxonomyAutocompleteService(repository([invalid])).autocomplete({
        query: "obkladac",
      }),
    ).rejects.toThrow(TaxonomyAutocompleteIntegrityError);
  });

  it("rejects an alias match kind that is impossible for skills", async () => {
    const invalid = candidate({
      code: "SKILL:LARGE_FORMAT",
      kind: "SKILL",
      matchedBy: "EXACT_ALIAS",
    });
    await expect(
      createTaxonomyAutocompleteService(repository([invalid])).autocomplete({
        query: "obklad",
        scope: "CAPABILITY",
      }),
    ).rejects.toThrow(TaxonomyAutocompleteIntegrityError);
  });

  it.each([
    "Volajte +421 900 123 456",
    "Kontakt majster@example.test",
    "Viac na www.example.test",
    "Profil @majster",
    "Adresa Hlavná 10",
    "API key abc123",
  ])("fails closed for an unsafe governed label: %s", async (label) => {
    await expect(
      createTaxonomyAutocompleteService(
        repository([candidate({ label })]),
      ).autocomplete({ query: "obklad" }),
    ).rejects.toThrow(TaxonomyAutocompleteIntegrityError);
  });

  it("preserves legitimate numeric trade wording", async () => {
    const result = await createTaxonomyAutocompleteService(
      repository([candidate({ label: "Montáž potrubia 1/2" })]),
    ).autocomplete({ query: "montaz" });
    expect(result.status).toBe("OK");
  });

  it("orders governed alias collisions by canonical label and code", async () => {
    const result = await createTaxonomyAutocompleteService(
      repository([
        candidate({
          code: "PROF:TILER",
          label: "Žeriavnik",
          matchedBy: "EXACT_ALIAS",
        }),
        candidate({
          code: "PROF:MASON",
          label: "Murár",
          matchedBy: "EXACT_ALIAS",
          professionCodes: ["PROF:MASON"],
        }),
      ]),
    ).autocomplete({ query: "stavebnik" });
    expect(result).toMatchObject({
      suggestions: [{ code: "PROF:MASON" }, { code: "PROF:TILER" }],
    });
  });

  it("returns canonical labels without leaking matched aliases or persistence extras", async () => {
    const value = {
      ...candidate({ matchedBy: "KEYWORD_ALIAS" }),
      matchedAlias: "tajny-volny-text",
      popularityCount: 99_999,
    } as TaxonomyAutocompleteCandidate;
    const result = await createTaxonomyAutocompleteService(
      repository([value]),
    ).autocomplete({ query: "oprava kupelne" });
    expect(JSON.stringify(result)).not.toMatch(
      /tajny|popular|oprava kupelne/iu,
    );
  });

  it("uses an explicit routing profession for a multi-profession service", async () => {
    const service = candidate({
      code: "SERV:RENOVATION",
      kind: "SERVICE",
      label: "Rekonštrukcia kúpeľne",
      professionCodes: ["PROF:MASON", "PROF:TILER"],
      routingProfessionCode: "PROF:TILER",
    });
    await expect(
      createTaxonomyAutocompleteService(repository([service])).autocomplete({
        query: "rekonstrukcia",
        scope: "DISCOVERY",
      }),
    ).resolves.toMatchObject({
      suggestions: [
        {
          code: "SERV:RENOVATION",
          routingProfessionCode: "PROF:TILER",
        },
      ],
    });
    const withoutRouting = { ...service };
    delete withoutRouting.routingProfessionCode;
    await expect(
      createTaxonomyAutocompleteService(
        repository([withoutRouting]),
      ).autocomplete({ query: "rekonstrukcia", scope: "DISCOVERY" }),
    ).rejects.toThrow(TaxonomyAutocompleteIntegrityError);
  });
});

const activeGovernance = Object.freeze({
  activated: true,
  contentClass: "CANONICAL",
  entryState: "ACTIVE",
  reviewState: "HUMAN_REVIEW_APPROVED",
});

function candidate(
  changes: Partial<TaxonomyAutocompleteCandidate> = {},
): TaxonomyAutocompleteCandidate {
  return {
    code: "PROF:TILER",
    governance: activeGovernance,
    kind: "PROFESSION",
    label: "Obkladač",
    memberCount: 0,
    matchedBy: "EXACT_CANONICAL",
    professionCodes: ["PROF:TILER"],
    ...changes,
  };
}

function repository(
  values: readonly TaxonomyAutocompleteCandidate[],
): TaxonomyAutocompletePersistence & {
  readonly findCandidates: ReturnType<typeof vi.fn>;
} {
  return {
    findCandidates: vi.fn(() => Promise.resolve(values)),
  };
}
