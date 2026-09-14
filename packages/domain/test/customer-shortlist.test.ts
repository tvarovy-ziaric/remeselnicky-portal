import { describe, expect, it, vi } from "vitest";

import type { CraftsmanProfileId } from "../src/craftsman-profile.js";
import type { CustomerProfileId } from "../src/customer-profile.js";
import type { UserId } from "../src/user.js";
import {
  createCustomerShortlistService,
  type CustomerShortlistPersistence,
} from "../src/customer-shortlist.js";

const actorUserId = "91000000-0000-4000-8000-000000000001" as UserId;
const customerProfileId =
  "91000000-0000-4000-8000-000000000002" as CustomerProfileId;
const craftsmanProfileId =
  "91000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const commandId = "91000000-0000-4000-8000-000000000004";

describe("customer shortlist service", () => {
  it("lazily derives the customer profile for ADD", async () => {
    const addOwned = vi.fn(() =>
      Promise.resolve({
        revision: 1,
        state: "ACTIVE",
        status: "APPLIED",
      } as const),
    );
    const service = createCustomerShortlistService({
      customerProfiles: {
        ensureForCustomerUse: vi.fn(() =>
          Promise.resolve({
            profile: {
              createdAt: new Date(),
              id: customerProfileId,
              ownerUserId: actorUserId,
              publicVisibility: "PRIVATE",
              searchIndexing: "DISALLOWED",
              updatedAt: new Date(),
            },
            status: "CREATED",
          } as const),
        ),
      },
      persistence: persistence({ addOwned }),
    });

    await service.add({
      actorUserId,
      commandId,
      craftsmanProfileId,
    });

    expect(addOwned).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfileId,
      customerProfileId,
    });
  });

  it("keeps list read-only but derives the customer profile for remove", async () => {
    const ensureForCustomerUse = vi.fn(() =>
      Promise.resolve({
        profile: {
          createdAt: new Date(),
          id: customerProfileId,
          ownerUserId: actorUserId,
          publicVisibility: "PRIVATE",
          searchIndexing: "DISALLOWED",
          updatedAt: new Date(),
        },
        status: "EXISTING",
      } as const),
    );
    const listOwned = vi.fn(() =>
      Promise.resolve({ entries: [], status: "OK" } as const),
    );
    const removeOwned = vi.fn(() =>
      Promise.resolve({
        revision: 0,
        state: "REMOVED",
        status: "UNCHANGED",
      } as const),
    );
    const service = createCustomerShortlistService({
      customerProfiles: { ensureForCustomerUse },
      persistence: persistence({ listOwned, removeOwned }),
    });

    await service.list(actorUserId);
    await service.remove({
      actorUserId,
      commandId,
      craftsmanProfileId,
    });

    expect(ensureForCustomerUse).toHaveBeenCalledOnce();
    expect(listOwned).toHaveBeenCalledWith(actorUserId);
    expect(removeOwned).toHaveBeenCalledOnce();
  });

  it("rejects malformed commands before any persistence call", async () => {
    const addOwned = vi.fn();
    const service = createCustomerShortlistService({
      customerProfiles: { ensureForCustomerUse: vi.fn() },
      persistence: persistence({ addOwned }),
    });

    await expect(
      service.add({
        actorUserId,
        commandId: "client-key",
        craftsmanProfileId,
      }),
    ).rejects.toThrow(/command id must be a UUID/u);
    expect(addOwned).not.toHaveBeenCalled();
  });
});

function persistence(
  overrides: Partial<CustomerShortlistPersistence>,
): CustomerShortlistPersistence {
  return {
    addOwned: vi.fn(),
    listOwned: vi.fn(),
    removeOwned: vi.fn(),
    ...overrides,
  };
}
