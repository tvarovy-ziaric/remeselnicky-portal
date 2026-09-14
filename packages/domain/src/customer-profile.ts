import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

declare const customerProfileIdBrand: unique symbol;

/** Stable, opaque identity of a private customer capability profile. */
export type CustomerProfileId = EntityId & {
  readonly [customerProfileIdBrand]: "CustomerProfileId";
};

/**
 * Customer profiles are private capability records. Trust fields exposed to an
 * invited provider must later use a separate, context-authorized projection.
 */
export interface CustomerProfile {
  readonly id: CustomerProfileId;
  readonly ownerUserId: UserId;
  readonly publicVisibility: "PRIVATE";
  readonly searchIndexing: "DISALLOWED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type EnsureCustomerProfilePersistenceResult =
  | {
      readonly status: "ACCOUNT_NOT_ACTIVE";
    }
  | {
      readonly profile: CustomerProfile;
      readonly status: "CREATED" | "EXISTING";
    };

/** Server-side persistence boundary for the lazy customer capability. */
export interface CustomerProfilePersistence {
  ensureForActiveOwner(
    ownerUserId: UserId,
  ): Promise<EnsureCustomerProfilePersistenceResult>;
}

export type EnsureCustomerProfileResult = Extract<
  EnsureCustomerProfilePersistenceResult,
  { readonly status: "CREATED" | "EXISTING" }
>;

export interface CustomerProfileService {
  /**
   * Called by an authenticated customer-side command using the session actor.
   * It intentionally accepts no separately client-selected owner identifier.
   */
  ensureForCustomerUse(
    actorUserId: UserId,
  ): Promise<EnsureCustomerProfileResult>;
}

export class CustomerProfileUnavailableError extends Error {
  readonly code = "CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE";

  constructor() {
    super("Customer functionality requires an active account.");
    this.name = "CustomerProfileUnavailableError";
  }
}

export function createCustomerProfileService(input: {
  readonly persistence: CustomerProfilePersistence;
}): CustomerProfileService {
  return Object.freeze({
    async ensureForCustomerUse(
      actorUserId: UserId,
    ): Promise<EnsureCustomerProfileResult> {
      assertUserId(actorUserId);
      const result = await input.persistence.ensureForActiveOwner(actorUserId);
      if (result.status === "ACCOUNT_NOT_ACTIVE") {
        throw new CustomerProfileUnavailableError();
      }
      return result;
    },
  });
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertUserId(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new TypeError("Customer profile actor user id must be a UUID.");
  }
}
