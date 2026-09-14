import { describe, expect, it, vi } from "vitest";

import {
  createIndicativePricingService,
  INDICATIVE_PRICE_MODES,
  IndicativePricingValidationError,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type IndicativePricingEntryId,
  type IndicativePricingPersistence,
  type UserId,
} from "../src/index.js";

const actorUserId = "47000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "47000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const entryId =
  "47000000-0000-4000-8000-000000000003" as IndicativePricingEntryId;
const professionId =
  "47000000-0000-4000-8000-000000000004" as CraftsmanProfessionId;
const commandId = "47000000-0000-4000-8000-000000000005";

describe("indicative pricing domain", () => {
  it("locks the complete set of D08 price modes", () => {
    expect(INDICATIVE_PRICE_MODES).toEqual([
      "FROM",
      "APPROXIMATE",
      "HOURLY",
      "PER_SQUARE_METER",
      "PER_UNIT",
      "OTHER",
    ]);
  });

  it("normalizes optional profession linkage and EUR-cent content", async () => {
    const persistence = fakePersistence();
    const service = createIndicativePricingService(persistence);

    await service.add({
      actorUserId,
      amountCents: 12_345,
      commandId,
      craftsmanProfessionId: professionId,
      craftsmanProfileId,
      entryId,
      note: "  Vrátane   bežného materiálu  ",
      priceMode: "FROM",
      serviceName: "  Montáž umývadla  ",
    });

    expect(persistence.addMock).toHaveBeenCalledWith({
      actorUserId,
      amountCents: 12_345,
      commandId,
      craftsmanProfessionId: professionId,
      craftsmanProfileId,
      entryId,
      note: "Vrátane bežného materiálu",
      priceMode: "FROM",
      serviceName: "Montáž umývadla",
    });
  });

  it("keeps profession linkage optional instead of forcing taxonomy", async () => {
    const persistence = fakePersistence();
    const service = createIndicativePricingService(persistence);

    await service.add({
      actorUserId,
      amountCents: 4_000,
      commandId,
      craftsmanProfileId,
      entryId,
      priceMode: "HOURLY",
      serviceName: "Diagnostika",
    });

    expect(persistence.addMock).toHaveBeenCalledWith(
      expect.objectContaining({ craftsmanProfessionId: null, note: null }),
    );
  });

  it("allows legitimate service fractions without treating them as addresses", async () => {
    const persistence = fakePersistence();
    const service = createIndicativePricingService(persistence);

    await service.add({
      actorUserId,
      amountCents: 5_000,
      commandId,
      craftsmanProfileId,
      entryId,
      priceMode: "PER_UNIT",
      serviceName: "Montáž potrubia 1/2",
    });

    expect(persistence.addMock).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: "Montáž potrubia 1/2" }),
    );
  });

  it.each([
    { amountCents: 0 },
    { amountCents: 1.5 },
    { amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { priceMode: "FIXED" },
    { serviceName: "" },
    { serviceName: "Oprava cez www.example.sk" },
    { serviceName: "Objednávka cez remeslo.sk" },
    { note: "Napíšte na majster@example.sk" },
    { note: "Správa cez @majster_jano" },
    { note: "Volajte +421 900 123 456" },
    { note: "Adresa: Hlavná 12" },
    { note: "heslo: sprístupni-ma" },
    { note: "Pozri https://example.sk" },
  ])("rejects unsafe or invalid pricing input %#", (change) => {
    const service = createIndicativePricingService(fakePersistence());
    expect(() =>
      service.add({
        actorUserId,
        amountCents: 1_000,
        commandId,
        craftsmanProfileId,
        entryId,
        note: null,
        priceMode: "APPROXIMATE",
        serviceName: "Oprava",
        ...change,
      } as Parameters<IndicativePricingPersistence["add"]>[0]),
    ).toThrow(IndicativePricingValidationError);
  });

  it("validates revision CAS and list visibility options", () => {
    const service = createIndicativePricingService(fakePersistence());
    expect(() =>
      service.archive({
        actorUserId,
        commandId,
        craftsmanProfileId,
        entryId,
        expectedRevision: 0,
      }),
    ).toThrow(/expectedRevision/u);
    expect(() =>
      service.listOwned({
        actorUserId,
        craftsmanProfileId,
        includeArchived: "yes" as unknown as boolean,
      }),
    ).toThrow(/includeArchived/u);
  });
});

function fakePersistence(): IndicativePricingPersistence & {
  readonly addMock: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn<IndicativePricingPersistence["add"]>(() =>
    Promise.resolve({ status: "PROFILE_UNAVAILABLE" }),
  );
  const archive = vi.fn<IndicativePricingPersistence["archive"]>(() =>
    Promise.resolve({ status: "ENTRY_UNAVAILABLE" }),
  );
  const edit = vi.fn<IndicativePricingPersistence["edit"]>(() =>
    Promise.resolve({ status: "ENTRY_UNAVAILABLE" }),
  );
  const listOwned = vi.fn<IndicativePricingPersistence["listOwned"]>(() =>
    Promise.resolve([]),
  );
  return { add, addMock: add, archive, edit, listOwned };
}
