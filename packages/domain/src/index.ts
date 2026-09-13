/** Framework-independent identifier used at domain boundaries. */
export type EntityId = string;

/** Minimal runtime descriptor proving that consumers share the domain package. */
export const domainContract = Object.freeze({
  entityIdRepresentation: "opaque-string",
} as const);
