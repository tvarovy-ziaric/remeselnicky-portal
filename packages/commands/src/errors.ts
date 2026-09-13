export type CommandAuthorizationFailure =
  "DENIED" | "INVALID_DECISION" | "POLICY_ERROR";

export type CommandStateFailure =
  "GUARD_ERROR" | "INVALID_DECISION" | "PRECONDITION_FAILED";

export class CommandAuthorizationError extends Error {
  public readonly code: string;
  public readonly failure: CommandAuthorizationFailure;

  public constructor(failure: CommandAuthorizationFailure, code: string) {
    super("Command authorization failed closed");
    this.code = code;
    this.failure = failure;
    this.name = "CommandAuthorizationError";
  }
}

export class CommandStateGuardError extends Error {
  public readonly code: string;
  public readonly failure: CommandStateFailure;

  public constructor(failure: CommandStateFailure, code: string) {
    super("Command state precondition failed closed");
    this.code = code;
    this.failure = failure;
    this.name = "CommandStateGuardError";
  }
}

export class CommandConfigurationError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Command handler configuration is invalid");
    this.code = code;
    this.name = "CommandConfigurationError";
  }
}

export class MissingIdempotencyKeyError extends Error {
  public readonly code = "IDEMPOTENCY_KEY_REQUIRED";

  public constructor() {
    super("A critical command requires an idempotency key");
    this.name = "MissingIdempotencyKeyError";
  }
}
