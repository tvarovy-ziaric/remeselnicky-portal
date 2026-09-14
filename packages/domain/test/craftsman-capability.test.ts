import { describe, expect, it } from "vitest";

import {
  assertAddCraftsmanSkillInput,
  assertAddCraftsmanSpecializationInput,
  assertMapCustomCraftsmanSkillInput,
  CraftsmanCapabilityValidationError,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type CraftsmanSkillId,
  type CraftsmanSpecializationId,
  type UserId,
} from "../src/index.js";

const actorUserId = "61000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "61000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const craftsmanProfessionId =
  "61000000-0000-4000-8000-000000000003" as CraftsmanProfessionId;
const craftsmanSkillId =
  "61000000-0000-4000-8000-000000000004" as CraftsmanSkillId;
const skillCatalogReleaseId = "61000000-0000-4000-8000-000000000005";

describe("craftsman capability commands", () => {
  it("accepts governed specializations and canonical skills linked to professions", () => {
    expect(() =>
      assertAddCraftsmanSpecializationInput({
        actorUserId,
        commandId: "61000000-0000-4000-8000-000000000006",
        craftsmanProfileId,
        craftsmanProfessionId,
        craftsmanSpecializationId:
          "61000000-0000-4000-8000-000000000007" as CraftsmanSpecializationId,
        specializationCode: "SPEC:SAFE_TEST",
        taxonomyReleaseId: "61000000-0000-4000-8000-000000000008",
      }),
    ).not.toThrow();
    expect(() =>
      assertAddCraftsmanSkillInput({
        actorUserId,
        canonicalSkillCode: "SKILL:SAFE_TEST",
        commandId: "61000000-0000-4000-8000-000000000009",
        craftsmanProfileId,
        craftsmanSkillId,
        identityKind: "CANONICAL",
        professionIds: [craftsmanProfessionId],
        skillCatalogReleaseId,
      }),
    ).not.toThrow();
  });

  it("retains accepted custom trade wording exactly and rejects control text", () => {
    const customText = "Ručné drážkovanie – lokálny výraz";
    const input = {
      actorUserId,
      commandId: "61000000-0000-4000-8000-000000000010",
      craftsmanProfileId,
      craftsmanSkillId,
      customText,
      identityKind: "CUSTOM" as const,
      professionIds: [craftsmanProfessionId],
    };
    expect(() => assertAddCraftsmanSkillInput(input)).not.toThrow();
    expect(input.customText).toBe(customText);
    expect(() =>
      assertAddCraftsmanSkillInput({ ...input, customText: "neplatný\ntext" }),
    ).toThrow(CraftsmanCapabilityValidationError);
    expect(() =>
      assertAddCraftsmanSkillInput({
        ...input,
        customText: "Montáž potrubia 1/2 palca",
      }),
    ).not.toThrow();
    expect(() =>
      assertAddCraftsmanSkillInput({
        ...input,
        customText: "Servis rozvodov 230/400 V",
      }),
    ).not.toThrow();
  });

  it.each([
    "Volajte +421 900 123 456",
    "Napíšte na majster@example.sk",
    "Pozri https://example.sk",
    "Nájdete ma cez remeslo.sk",
    "Správa cez @majster_jano",
    "Adresa: Hlavná 12",
    "heslo: sprístupni-ma",
  ])(
    "rejects future-public contact, address or secret wording: %s",
    (customText) => {
      expect(() =>
        assertAddCraftsmanSkillInput({
          actorUserId,
          commandId: "61000000-0000-4000-8000-000000000013",
          craftsmanProfileId,
          craftsmanSkillId,
          customText,
          identityKind: "CUSTOM",
          professionIds: [craftsmanProfessionId],
        }),
      ).toThrow(CraftsmanCapabilityValidationError);
    },
  );

  it("does not accept skill levels or duplicate profession links", () => {
    expect(() =>
      assertAddCraftsmanSkillInput({
        actorUserId,
        commandId: "61000000-0000-4000-8000-000000000011",
        craftsmanProfileId,
        craftsmanSkillId,
        customText: "Bez úrovne",
        identityKind: "CUSTOM",
        professionIds: [craftsmanProfessionId, craftsmanProfessionId],
      }),
    ).toThrow(CraftsmanCapabilityValidationError);
  });

  it("allows an append-only first mapping revision from zero", () => {
    expect(() =>
      assertMapCustomCraftsmanSkillInput({
        actorUserId,
        canonicalSkillCode: "SKILL:SAFE_TEST",
        commandId: "61000000-0000-4000-8000-000000000012",
        craftsmanProfileId,
        craftsmanSkillId,
        expectedMappingRevision: 0,
        skillCatalogReleaseId,
      }),
    ).not.toThrow();
  });
});
