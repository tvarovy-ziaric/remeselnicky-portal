import { describe, expect, it } from "vitest";

import {
  assertCreatePortfolioProjectInput,
  assertEditPortfolioProjectInput,
  PortfolioProjectValidationError,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type CreatePortfolioProjectInput,
  type PortfolioProjectId,
  type UserId,
} from "../src/index.js";

const actorUserId = "72000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "72000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const portfolioProjectId =
  "72000000-0000-4000-8000-000000000003" as PortfolioProjectId;
const professionId =
  "72000000-0000-4000-8000-000000000004" as CraftsmanProfessionId;

describe("portfolio project domain boundary", () => {
  it("accepts a bounded private self-declared project content snapshot", () => {
    expect(() =>
      assertCreatePortfolioProjectInput(createInput()),
    ).not.toThrow();
  });

  it("requires title, short description and at least one profession", () => {
    expect(() =>
      assertCreatePortfolioProjectInput(createInput({ title: "" })),
    ).toThrow(PortfolioProjectValidationError);
    expect(() =>
      assertCreatePortfolioProjectInput(
        createInput({ shortDescription: "príliš krátke".slice(0, 5) }),
      ),
    ).toThrow(PortfolioProjectValidationError);
    expect(() =>
      assertCreatePortfolioProjectInput(createInput({ professionIds: [] })),
    ).toThrow(PortfolioProjectValidationError);
  });

  it.each([
    { title: "Volajte +421 900 123 456" },
    { shortDescription: "Fotografie pošlem cez majster@example.sk" },
    { contribution: "Viac na https://example.sk" },
    { materialsAndTechnologies: "Profil @majster_jano" },
    { problem: "Adresa: Hlavná 12" },
    { solution: "Klient menom Ján Novák" },
    { solution: "api key: sprístupni-ma" },
  ])(
    "rejects contact, address, customer identity or secret text %#",
    (change) => {
      expect(() =>
        assertCreatePortfolioProjectInput(createInput(change)),
      ).toThrow(PortfolioProjectValidationError);
    },
  );

  it("preserves legitimate trade notation", () => {
    expect(() =>
      assertCreatePortfolioProjectInput(
        createInput({
          materialsAndTechnologies: "Potrubie 1/2 palca, rozvody 230/400 V",
        }),
      ),
    ).not.toThrow();
  });

  it("requires paired bounded duration and a noncontractual cents range", () => {
    expect(() =>
      assertCreatePortfolioProjectInput(createInput({ durationUnit: null })),
    ).toThrow(PortfolioProjectValidationError);
    expect(() =>
      assertCreatePortfolioProjectInput(
        createInput({
          indicativePriceMaxCents: 50_000,
          indicativePriceMinCents: 60_000,
        }),
      ),
    ).toThrow(PortfolioProjectValidationError);
  });

  it("requires municipality to be accompanied by its approximate district", () => {
    expect(() =>
      assertCreatePortfolioProjectInput(
        createInput({ districtCode: null, municipalityCode: "MUNI:TEST" }),
      ),
    ).toThrow(PortfolioProjectValidationError);
  });

  it("requires positive CAS revisions for edits", () => {
    expect(() =>
      assertEditPortfolioProjectInput({
        ...createInput(),
        expectedRevision: 0,
      }),
    ).toThrow(PortfolioProjectValidationError);
  });
});

function createInput(changes: Partial<CreatePortfolioProjectInput> = {}) {
  return { ...createInputShape(), ...changes };
}

function createInputShape(): CreatePortfolioProjectInput {
  return {
    actorUserId,
    commandId: "72000000-0000-4000-8000-000000000005",
    contribution: "Realizácia rozvodov a zapojenie rozvádzača",
    craftsmanProfileId,
    districtCode: "DISTRICT:TEST",
    durationUnit: "DAYS" as const,
    durationValue: 4,
    indicativePriceMaxCents: 250_000,
    indicativePriceMinCents: 180_000,
    materialsAndTechnologies: "Medené vedenie a modulárne prvky",
    municipalityCode: "MUNICIPALITY:TEST",
    portfolioProjectId,
    problem: "Pôvodné vedenie bolo technicky nevyhovujúce",
    professionIds: [professionId],
    shortDescription: "Obnova vnútorných rozvodov v staršom objekte",
    skillIds: [],
    solution: "Rozvody boli bezpečne nahradené a označené",
    specializationIds: [],
    title: "Obnova vnútorných rozvodov",
  };
}
