import { describe, expect, it, vi } from "vitest";

import {
  createCustomerProfileService,
  type CustomerProfile,
  type CustomerProfileId,
  type CustomerProfilePersistence,
  type UserId,
} from "../src/index.js";

const ownerUserId = "00000000-0000-4000-8000-000000000201" as UserId;

describe("CustomerProfile lazy creation", () => {
  it.each(["CREATED", "EXISTING"] as const)(
    "returns the private profile for a %s persistence result",
    async (status) => {
      const profile = customerProfile(ownerUserId);
      const ensureForActiveOwner = vi.fn(() =>
        Promise.resolve({ profile, status } as const),
      );
      const persistence: CustomerProfilePersistence = {
        ensureForActiveOwner,
      };
      const service = createCustomerProfileService({ persistence });

      await expect(service.ensureForCustomerUse(ownerUserId)).resolves.toEqual({
        profile,
        status,
      });
      expect(ensureForActiveOwner).toHaveBeenCalledWith(ownerUserId);
      expect(profile.publicVisibility).toBe("PRIVATE");
      expect(profile.searchIndexing).toBe("DISALLOWED");
    },
  );

  it("fails closed for a suspended, deactivated, or missing account", async () => {
    const persistence: CustomerProfilePersistence = {
      ensureForActiveOwner: vi.fn(() =>
        Promise.resolve({ status: "ACCOUNT_NOT_ACTIVE" as const }),
      ),
    };
    const service = createCustomerProfileService({ persistence });

    await expect(
      service.ensureForCustomerUse(ownerUserId),
    ).rejects.toMatchObject({
      code: "CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE",
      name: "CustomerProfileUnavailableError",
    });
  });

  it("rejects malformed actor identity before persistence", async () => {
    const ensureForActiveOwner = vi.fn();
    const persistence: CustomerProfilePersistence = {
      ensureForActiveOwner,
    };
    const service = createCustomerProfileService({ persistence });

    await expect(
      service.ensureForCustomerUse("customer-selected-owner" as UserId),
    ).rejects.toThrow(/actor user id must be a UUID/u);
    expect(ensureForActiveOwner).not.toHaveBeenCalled();
  });

  it("adds customer capability without replacing an existing craftsman capability", async () => {
    const capabilities = { craftsman: true, customer: false };
    const profile = customerProfile(ownerUserId);
    const persistence: CustomerProfilePersistence = {
      ensureForActiveOwner: vi.fn(() => {
        capabilities.customer = true;
        return Promise.resolve({ profile, status: "CREATED" as const });
      }),
    };
    const service = createCustomerProfileService({ persistence });

    await service.ensureForCustomerUse(ownerUserId);

    expect(capabilities).toEqual({ craftsman: true, customer: true });
  });
});

function customerProfile(userId: UserId): CustomerProfile {
  const createdAt = new Date("2026-09-14T10:00:00.000Z");
  return Object.freeze({
    createdAt,
    id: "00000000-0000-4000-8000-000000000202" as CustomerProfileId,
    ownerUserId: userId,
    publicVisibility: "PRIVATE",
    searchIndexing: "DISALLOWED",
    updatedAt: createdAt,
  });
}
