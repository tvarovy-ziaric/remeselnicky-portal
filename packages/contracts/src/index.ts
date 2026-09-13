import type { EntityId } from "@portal/domain";

/** Minimal transport-safe reference shared by API producers and consumers. */
export interface ApiResourceReference {
  readonly id: EntityId;
}

/** Runtime contract marker used to verify cross-workspace imports. */
export const platformContract = Object.freeze({
  apiVersion: "v1",
} as const);

export type PlatformContract = typeof platformContract;
