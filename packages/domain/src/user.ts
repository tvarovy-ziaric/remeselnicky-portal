import type { EntityId } from "./index.js";

export const USER_ACCOUNT_STATES = Object.freeze([
  "ACTIVE",
  "SUSPENDED",
  "DEACTIVATED",
] as const);

export type UserAccountState = (typeof USER_ACCOUNT_STATES)[number];

declare const userIdBrand: unique symbol;

/** Stable, opaque identity of one portal account. */
export type UserId = EntityId & { readonly [userIdBrand]: "UserId" };

/**
 * One account identity. Customer and craftsman capabilities are represented by
 * optional profiles outside this entity, never by an exclusive role value.
 */
export interface User {
  readonly id: UserId;
  readonly accountState: UserAccountState;
  readonly accountStateChangedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isUserAccountState(value: unknown): value is UserAccountState {
  return USER_ACCOUNT_STATES.some((state) => state === value);
}
