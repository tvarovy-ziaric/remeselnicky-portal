import { describe, expect, it, vi } from "vitest";

import {
  assertTaxonomySuggestionDecisionAllowed,
  createTaxonomySuggestionService,
  normalizeSubmitTaxonomySuggestionInput,
  normalizeTaxonomySuggestionDecision,
  normalizeTaxonomySuggestionLookup,
  TaxonomySuggestionValidationError,
  type TaxonomySuggestionPersistence,
} from "../src/index.js";

const ids = {
  suggestionId: "10000000-0000-4000-8000-000000000001",
  commandId: "10000000-0000-4000-8000-000000000002",
  actorUserId: "10000000-0000-4000-8000-000000000003",
  requesterCraftsmanProfileId: "10000000-0000-4000-8000-000000000004",
  actorAdminUserId: "10000000-0000-4000-8000-000000000005",
} as const;
const submitIds = {
  actorUserId: ids.actorUserId,
  commandId: ids.commandId,
  requesterCraftsmanProfileId: ids.requesterCraftsmanProfileId,
  suggestionId: ids.suggestionId,
} as const;

describe("managed taxonomy suggestion domain", () => {
  it("normalizes submitted text and derives an accent-insensitive duplicate key", () => {
    const input = normalizeSubmitTaxonomySuggestionInput({
      ...submitIds,
      proposedName: "  Pokladač   vinylu ",
      proposedDescription: "  Pokládka vinylovej podlahy v interiéri. ",
      suggestedKind: "SERVICE",
    });
    expect(input).toMatchObject({
      proposedName: "Pokladač vinylu",
      proposedDescription: "Pokládka vinylovej podlahy v interiéri.",
      suggestedKind: "SERVICE",
    });
    expect(normalizeTaxonomySuggestionLookup("  POKLÁDAČ--vinylu ")).toBe(
      "pokladac vinylu",
    );
  });

  it("rejects injected fields and bounded invalid user text", () => {
    expect(() =>
      normalizeSubmitTaxonomySuggestionInput({
        ...submitIds,
        proposedName: "Nová služba",
        proposedDescription: "Dostatočne jasný opis služby.",
        state: "APPROVED_AS_NEW",
      } as never),
    ).toThrow(TaxonomySuggestionValidationError);
    expect(() =>
      normalizeSubmitTaxonomySuggestionInput({
        ...submitIds,
        proposedName: "X",
        proposedDescription: "Príliš krátke",
      }),
    ).toThrow(TaxonomySuggestionValidationError);
  });

  it("requires a meaningful note for mapping and rejection", () => {
    expect(() =>
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        commandId: ids.commandId,
        decision: "MAPPED_TO_EXISTING",
        expectedRevision: 1,
        suggestionId: ids.suggestionId,
        resolvedKind: "SERVICE",
        resolvedTaxonomyCode: "SERV:VINYL_FLOOR",
        addProposedNameAsAlias: false,
        adminDecisionNote: "Krátke",
      }),
    ).toThrow(TaxonomySuggestionValidationError);
    expect(() =>
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        commandId: ids.commandId,
        decision: "REJECTED",
        expectedRevision: 1,
        suggestionId: ids.suggestionId,
        adminDecisionNote: "Nie",
      }),
    ).toThrow(TaxonomySuggestionValidationError);
  });

  it("normalizes explicit approve and map decisions without auto-adding aliases", () => {
    expect(
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        aliases: ["lepenie vinylu", "vinyl podlaha"],
        canonicalCode: " serv:vinyl_floor_special ",
        canonicalDescription: "Pokládka vinylových podláh.",
        canonicalKind: "SERVICE",
        canonicalName: " Pokládka vinylovej podlahy ",
        commandId: ids.commandId,
        decision: "APPROVED_AS_NEW",
        expectedRevision: 1,
        primaryProfessionCode: "PROF:FLOOR_LAYER",
        professionCodes: ["PROF:FLOOR_LAYER"],
        suggestionId: ids.suggestionId,
      }),
    ).toMatchObject({
      aliases: ["lepenie vinylu", "vinyl podlaha"],
      canonicalCode: "SERV:VINYL_FLOOR_SPECIAL",
      canonicalName: "Pokládka vinylovej podlahy",
      adminDecisionNote: null,
    });
    expect(
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        addProposedNameAsAlias: false,
        adminDecisionNote: "Zodpovedá existujúcej spravovanej službe.",
        commandId: ids.commandId,
        decision: "MAPPED_TO_EXISTING",
        expectedRevision: 1,
        resolvedKind: "SERVICE",
        resolvedTaxonomyCode: "SERV:VINYL_FLOOR",
        suggestionId: ids.suggestionId,
      }),
    ).toMatchObject({ addProposedNameAsAlias: false });
  });

  it("rejects duplicate normalized aliases, kind/code mismatches and stale decisions", () => {
    expect(() =>
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        aliases: ["elektrikár", "ELEKTRIKAR"],
        canonicalCode: "PROF:ELECTRICIAN_2",
        canonicalDescription: null,
        canonicalKind: "PROFESSION",
        canonicalName: "Elektromontér",
        commandId: ids.commandId,
        decision: "APPROVED_AS_NEW",
        expectedRevision: 1,
        primaryProfessionCode: null,
        professionCodes: [],
        suggestionId: ids.suggestionId,
      }),
    ).toThrow(TaxonomySuggestionValidationError);
    expect(() =>
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        aliases: [],
        canonicalCode: "SERV:BAD_KIND",
        canonicalDescription: null,
        canonicalKind: "PROFESSION",
        canonicalName: "Elektrikár",
        commandId: ids.commandId,
        decision: "APPROVED_AS_NEW",
        expectedRevision: 1,
        primaryProfessionCode: null,
        professionCodes: [],
        suggestionId: ids.suggestionId,
      }),
    ).toThrow(TaxonomySuggestionValidationError);
    expect(() =>
      normalizeTaxonomySuggestionDecision({
        actorAdminUserId: ids.actorAdminUserId,
        aliases: [],
        canonicalCode: "SERV:MULTI_TRADE",
        canonicalDescription: null,
        canonicalKind: "SERVICE",
        canonicalName: "Viacprofesijná služba",
        commandId: ids.commandId,
        decision: "APPROVED_AS_NEW",
        expectedRevision: 1,
        primaryProfessionCode: "PROF:UNKNOWN",
        professionCodes: ["PROF:FLOOR_LAYER"],
        suggestionId: ids.suggestionId,
      }),
    ).toThrow(TaxonomySuggestionValidationError);
    expect(() =>
      assertTaxonomySuggestionDecisionAllowed(
        { revision: 2, state: "PENDING" },
        { expectedRevision: 1 },
      ),
    ).toThrow(TaxonomySuggestionValidationError);
    expect(() =>
      assertTaxonomySuggestionDecisionAllowed(
        { revision: 1, state: "REJECTED" },
        { expectedRevision: 1 },
      ),
    ).toThrow(TaxonomySuggestionValidationError);
  });

  it("passes only normalized commands to persistence", async () => {
    const submit = vi.fn().mockResolvedValue({
      status: "PENDING_LIMIT_REACHED" as const,
    });
    const persistence: TaxonomySuggestionPersistence = {
      submit,
      decide: vi.fn().mockResolvedValue({ status: "SUGGESTION_UNAVAILABLE" }),
    };
    const service = createTaxonomySuggestionService({ persistence });
    await service.submit({
      ...submitIds,
      proposedName: "  Nová-práca ",
      proposedDescription: " Dlhší a zrozumiteľný opis práce. ",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedName: "Nová-práca",
        normalizedProposedName: "nova praca",
        suggestedKind: null,
      }),
    );
    expect(() =>
      service.submit({
        ...submitIds,
        proposedName: "--",
        proposedDescription: "Dlhší a zrozumiteľný opis práce.",
      }),
    ).toThrow(TaxonomySuggestionValidationError);
  });
});
