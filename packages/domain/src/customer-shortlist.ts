import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type {
  CustomerProfileId,
  CustomerProfileService,
} from "./customer-profile.js";
import type { UserId } from "./user.js";

export type CustomerShortlistState = "ACTIVE" | "REMOVED";
export type CustomerShortlistCommandStatus =
  "APPLIED" | "UNCHANGED" | "DEDUPLICATED";

export interface CustomerShortlistEntry {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly revision: number;
  readonly savedAt: Date;
  readonly state: "ACTIVE";
  readonly targetAvailable: boolean;
}

export interface CustomerShortlistCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
}

export interface PersistCustomerShortlistCommandInput extends CustomerShortlistCommandInput {
  readonly customerProfileId: CustomerProfileId;
}

export type CustomerShortlistCommandResult = Readonly<
  | {
      readonly activeShortlistSize?: number;
      readonly revision: number;
      readonly state: CustomerShortlistState;
      readonly status: CustomerShortlistCommandStatus;
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" | "TARGET_NOT_AVAILABLE" }
>;

export type CustomerShortlistListResult = Readonly<
  | {
      readonly entries: readonly CustomerShortlistEntry[];
      readonly status: "OK";
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" }
>;

export interface CustomerShortlistPersistence {
  addOwned(
    input: PersistCustomerShortlistCommandInput,
  ): Promise<CustomerShortlistCommandResult>;
  listOwned(actorUserId: UserId): Promise<CustomerShortlistListResult>;
  removeOwned(
    input: PersistCustomerShortlistCommandInput,
  ): Promise<CustomerShortlistCommandResult>;
}

export interface CustomerShortlistService {
  add(
    input: CustomerShortlistCommandInput,
  ): Promise<CustomerShortlistCommandResult>;
  list(actorUserId: UserId): Promise<CustomerShortlistListResult>;
  remove(
    input: CustomerShortlistCommandInput,
  ): Promise<CustomerShortlistCommandResult>;
}

export function createCustomerShortlistService(input: {
  readonly customerProfiles: CustomerProfileService;
  readonly persistence: CustomerShortlistPersistence;
}): CustomerShortlistService {
  return Object.freeze({
    async add(command: CustomerShortlistCommandInput) {
      assertCommand(command);
      const customer = await input.customerProfiles.ensureForCustomerUse(
        command.actorUserId,
      );
      return input.persistence.addOwned({
        ...command,
        customerProfileId: customer.profile.id,
      });
    },
    list(actorUserId: UserId) {
      assertUuid(actorUserId, "Shortlist actor user id");
      return input.persistence.listOwned(actorUserId);
    },
    async remove(command: CustomerShortlistCommandInput) {
      assertCommand(command);
      const customer = await input.customerProfiles.ensureForCustomerUse(
        command.actorUserId,
      );
      return input.persistence.removeOwned({
        ...command,
        customerProfileId: customer.profile.id,
      });
    },
  });
}

export function assertCustomerShortlistCommandInput(
  input: CustomerShortlistCommandInput,
): void {
  assertCommand(input);
}

function assertCommand(input: CustomerShortlistCommandInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Shortlist command must be an object.");
  }
  assertUuid(input.actorUserId, "Shortlist actor user id");
  assertUuid(input.commandId, "Shortlist command id");
  assertUuid(input.craftsmanProfileId, "Shortlist craftsman profile id");
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`${label} must be a UUID.`);
  }
}
