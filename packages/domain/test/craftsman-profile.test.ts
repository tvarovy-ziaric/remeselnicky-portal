import { describe, expect, it, vi } from "vitest";

import {
  CRAFTSMAN_PROFILE_TYPES,
  CraftsmanProfileValidationError,
  createCraftsmanProfileService,
  isCraftsmanProfileType,
  type CraftsmanProfile,
  type CraftsmanProfileId,
  type CraftsmanProfilePersistence,
  type UserId,
} from "../src/index.js";

const ownerUserId = "00000000-0000-4000-8000-000000001503" as UserId;
const profileId = "00000000-0000-4000-8000-000000001504" as CraftsmanProfileId;

describe("CraftsmanProfile private draft domain", () => {
  it("models INDIVIDUAL and COMPANY as one non-exclusive account capability", () => {
    expect(CRAFTSMAN_PROFILE_TYPES).toEqual(["INDIVIDUAL", "COMPANY"]);
    expect(isCraftsmanProfileType("INDIVIDUAL")).toBe(true);
    expect(isCraftsmanProfileType("CUSTOMER")).toBe(false);
  });

  it("permits a deliberately incomplete private draft", async () => {
    const persistence = fakePersistence();
    const service = createCraftsmanProfileService(persistence);

    await service.createPrivateDraft({
      actorUserId: ownerUserId,
      profileType: "INDIVIDUAL",
    });

    expect(persistence.createPrivateDraft).toHaveBeenCalledWith({
      about: null,
      nickname: null,
      actorUserId: ownerUserId,
      profileType: "INDIVIDUAL",
      realFirstName: null,
      realLastName: null,
    });
  });

  it("normalizes type-specific identity details without accepting verification", async () => {
    const persistence = fakePersistence();
    const service = createCraftsmanProfileService(persistence);

    await service.createPrivateDraft({
      about: "  Rodinná dielňa\r\nS tradíciou  ",
      companyRegistrationNumber: "12345678",
      officialCompanyName: "  Poctivé remeslo, s. r. o.  ",
      actorUserId: ownerUserId,
      profileType: "COMPANY",
    });

    expect(persistence.createPrivateDraft).toHaveBeenCalledWith({
      about: "Rodinná dielňa\nS tradíciou",
      companyRegistrationNumber: "12345678",
      officialCompanyName: "Poctivé remeslo, s. r. o.",
      actorUserId: ownerUserId,
      profileType: "COMPANY",
    });
  });

  it("rejects partial individual identity, unsafe text, invalid IČO and stale-shape revisions", () => {
    const service = createCraftsmanProfileService(fakePersistence());

    expect(() =>
      service.createPrivateDraft({
        actorUserId: ownerUserId,
        profileType: "INDIVIDUAL",
        realFirstName: "Ján",
      }),
    ).toThrow(CraftsmanProfileValidationError);
    expect(() =>
      service.createPrivateDraft({
        officialCompanyName: "Firma\nInjection",
        actorUserId: ownerUserId,
        profileType: "COMPANY",
      }),
    ).toThrow(/invalid/u);
    expect(() =>
      service.createPrivateDraft({
        about: "\tOpis so zakázaným tabulátorom",
        actorUserId: ownerUserId,
        profileType: "COMPANY",
      }),
    ).toThrow(/invalid/u);
    expect(() =>
      service.createPrivateDraft({
        actorUserId: ownerUserId,
        officialCompanyName: "Firma\n",
        profileType: "COMPANY",
      }),
    ).toThrow(/invalid/u);
    expect(() =>
      service.createPrivateDraft({
        companyRegistrationNumber: "SK-123",
        actorUserId: ownerUserId,
        profileType: "COMPANY",
      }),
    ).toThrow(/8 digits/u);
    expect(() =>
      service.replacePrivateDraft({
        about: null,
        actorUserId: ownerUserId,
        expectedRevision: 0,
        nickname: null,
        profileId,
        profileType: "INDIVIDUAL",
        realFirstName: null,
        realLastName: null,
      }),
    ).toThrow(/positive safe integer/u);
  });

  it("derives the owner from the single authenticated actor source", async () => {
    const persistence = fakePersistence();
    const service = createCraftsmanProfileService(persistence);
    const command = {
      actorUserId: ownerUserId,
      profileType: "COMPANY" as const,
    };

    await service.createPrivateDraft(command);

    expect(command).not.toHaveProperty("ownerUserId");
    expect(persistence.createPrivateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ownerUserId }),
    );
  });

  it("passes owner identity and expected revision to the explicit replacement command", async () => {
    const persistence = fakePersistence();
    const service = createCraftsmanProfileService(persistence);

    await service.replacePrivateDraft({
      about: "  Precízna práca  ",
      actorUserId: ownerUserId,
      expectedRevision: 3,
      nickname: "  Majster Jano  ",
      profileId,
      profileType: "INDIVIDUAL",
      realFirstName: "  Ján  ",
      realLastName: "  Remeselník  ",
    });

    expect(persistence.replacePrivateDraft).toHaveBeenCalledWith({
      about: "Precízna práca",
      actorUserId: ownerUserId,
      expectedRevision: 3,
      nickname: "Majster Jano",
      profileId,
      profileType: "INDIVIDUAL",
      realFirstName: "Ján",
      realLastName: "Remeselník",
    });
  });
});

function fakePersistence(): CraftsmanProfilePersistence & {
  createPrivateDraft: ReturnType<typeof vi.fn>;
  findOwnedPrivateDraft: ReturnType<typeof vi.fn>;
  replacePrivateDraft: ReturnType<typeof vi.fn>;
} {
  const profile: CraftsmanProfile = {
    about: null,
    createdAt: new Date("2026-09-14T00:00:00.000Z"),
    id: profileId,
    identityVerification: null,
    nickname: null,
    ownerUserId,
    profileType: "INDIVIDUAL",
    realFirstName: null,
    realLastName: null,
    revision: 1,
    updatedAt: new Date("2026-09-14T00:00:00.000Z"),
  };
  const createPrivateDraft = vi.fn<
    CraftsmanProfilePersistence["createPrivateDraft"]
  >(() => Promise.resolve({ status: "CREATED", profile }));
  const findOwnedPrivateDraft = vi.fn<
    CraftsmanProfilePersistence["findOwnedPrivateDraft"]
  >(() => Promise.resolve(profile));
  const replacePrivateDraft = vi.fn<
    CraftsmanProfilePersistence["replacePrivateDraft"]
  >(() => Promise.resolve({ status: "UPDATED", profile }));
  return { createPrivateDraft, findOwnedPrivateDraft, replacePrivateDraft };
}
