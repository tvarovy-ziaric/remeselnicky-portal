import {
  authorizationDecision,
  type AuthorizationDecision,
} from "./decision.js";
import { assertSafeIdentifier } from "./policy.js";

const publicOperation = Symbol("portal.authorization.public-operation");

export interface PublicOperation<Identifier extends string = string> {
  readonly identifier: Identifier;
  readonly [publicOperation]: true;
}

export function definePublicOperation<const Identifier extends string>(
  identifier: Identifier,
): PublicOperation<Identifier> {
  assertSafeIdentifier(identifier, "public operation");
  return Object.freeze({
    identifier,
    [publicOperation]: true as const,
  });
}

export interface PublicAccessAllowlist {
  authorize(operation: PublicOperation): AuthorizationDecision;
}

export function createPublicAccessAllowlist(
  operations: readonly PublicOperation[],
): PublicAccessAllowlist {
  const identifiers = new Set<string>();
  const allowlistedOperations = new Set<object>();

  for (const operation of operations) {
    if (!isPublicOperation(operation)) {
      throw new Error(
        "Only server-defined public operations can be allowlisted",
      );
    }
    if (identifiers.has(operation.identifier)) {
      throw new Error(`Duplicate public operation: ${operation.identifier}`);
    }
    identifiers.add(operation.identifier);
    allowlistedOperations.add(operation);
  }

  return Object.freeze({
    authorize(operation: PublicOperation): AuthorizationDecision {
      return allowlistedOperations.has(operation)
        ? authorizationDecision("PUBLIC_OPERATION_ALLOWLISTED")
        : authorizationDecision("PUBLIC_OPERATION_NOT_ALLOWLISTED");
    },
  });
}

function isPublicOperation(value: unknown): value is PublicOperation {
  return (
    typeof value === "object" &&
    value !== null &&
    publicOperation in value &&
    value[publicOperation] === true
  );
}
