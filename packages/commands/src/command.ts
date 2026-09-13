import {
  CommandAuthorizationError,
  CommandConfigurationError,
  CommandStateGuardError,
  MissingIdempotencyKeyError,
} from "./errors.js";
import type {
  DomainEventCollector,
  IdempotencyIdentity,
  IdempotencyStore,
  TransactionRunner,
} from "./ports.js";

const commandDefinition = Symbol("portal.commands.definition");
const stableIdentifier = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

export type CommandGateDecision =
  | { readonly effect: "DENY"; readonly code: string }
  | { readonly effect: "PERMIT" };

const permitted: CommandGateDecision = Object.freeze({ effect: "PERMIT" });

export function permitCommand(): CommandGateDecision {
  return permitted;
}

export function denyCommand(code: string): CommandGateDecision {
  assertStableIdentifier(code, "denial code");
  return Object.freeze({ code, effect: "DENY" });
}

export interface CommandLoadContext<Transaction, Input> {
  readonly input: Readonly<Input>;
  readonly transaction: Transaction;
}

export interface CommandGuardContext<
  Transaction,
  Actor,
  Input,
  State,
> extends CommandLoadContext<Transaction, Input> {
  readonly actor: Actor;
  readonly current: Readonly<State>;
}

export interface CommandMutation<Result, Event> {
  readonly events: readonly Event[];
  readonly result: Result;
}

interface CommandDefinitionBase<
  Name extends string,
  Transaction,
  Actor,
  Input,
  State,
  Result,
  Event,
> {
  readonly authorize: (
    context: CommandGuardContext<Transaction, Actor, Input, State>,
  ) => CommandGateDecision | Promise<CommandGateDecision>;
  readonly guard: (
    context: CommandGuardContext<Transaction, Actor, Input, State>,
  ) => CommandGateDecision | Promise<CommandGateDecision>;
  readonly loadCurrent: (
    context: CommandLoadContext<Transaction, Input>,
  ) => Promise<State>;
  readonly mutate: (
    context: CommandGuardContext<Transaction, Actor, Input, State>,
  ) => Promise<CommandMutation<Result, Event>>;
  readonly name: Name;
}

type CommandReliability<Actor, Input> =
  | {
      readonly critical: false;
    }
  | {
      readonly critical: true;
      readonly idempotencyScope: (context: {
        readonly actor: Actor;
        readonly input: Readonly<Input>;
      }) => string;
    };

export type CommandDefinition<
  Name extends string,
  Transaction,
  Actor,
  Input,
  State,
  Result,
  Event,
> = CommandDefinitionBase<
  Name,
  Transaction,
  Actor,
  Input,
  State,
  Result,
  Event
> &
  CommandReliability<Actor, Input> & {
    readonly [commandDefinition]: true;
  };

export function defineCommand<
  const Name extends string,
  Transaction,
  Actor,
  Input,
  State,
  Result,
  Event,
>(
  definition: CommandDefinitionBase<
    Name,
    Transaction,
    Actor,
    Input,
    State,
    Result,
    Event
  > &
    CommandReliability<Actor, Input>,
): CommandDefinition<Name, Transaction, Actor, Input, State, Result, Event> {
  assertStableIdentifier(definition.name, "command name");
  return Object.freeze({
    ...definition,
    [commandDefinition]: true as const,
  });
}

export interface CommandRequest<Actor, Input> {
  readonly actor: Actor;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  /** Command-specific intent only; current state is loaded server-side. */
  readonly input: Readonly<Input>;
}

export type CommandResult<Result> =
  | { readonly disposition: "EXECUTED"; readonly result: Result }
  | { readonly disposition: "REPLAYED"; readonly result: Result };

export interface CommandHandler<Actor, Input, Result> {
  handle(request: CommandRequest<Actor, Input>): Promise<CommandResult<Result>>;
}

export interface CommandHandlerDependencies<Transaction> {
  readonly events: DomainEventCollector<Transaction>;
  readonly idempotency: IdempotencyStore<Transaction>;
  readonly transactions: TransactionRunner<Transaction>;
}

export function createCommandHandler<
  Name extends string,
  Transaction,
  Actor,
  Input,
  State,
  Result,
  Event,
>(
  definition: CommandDefinition<
    Name,
    Transaction,
    Actor,
    Input,
    State,
    Result,
    Event
  >,
  dependencies: CommandHandlerDependencies<Transaction>,
): CommandHandler<Actor, Input, Result> {
  assertCommandDefinition(definition);

  return Object.freeze({
    async handle(
      request: CommandRequest<Actor, Input>,
    ): Promise<CommandResult<Result>> {
      assertBoundedValue(request.correlationId, "correlation ID");
      const idempotencyIdentity = criticalIdentity(definition, request);

      return dependencies.transactions.run(async (transaction) => {
        const current = await definition.loadCurrent({
          input: request.input,
          transaction,
        });
        const context = {
          actor: request.actor,
          current,
          input: request.input,
          transaction,
        };

        await requireAuthorization(() => definition.authorize(context));

        if (idempotencyIdentity !== undefined) {
          const claim = await dependencies.idempotency.claim<Result>(
            transaction,
            idempotencyIdentity,
          );
          if (claim.status === "REPLAY") {
            return { disposition: "REPLAYED", result: claim.result };
          }
          if (claim.status !== "ACQUIRED") {
            throw new CommandConfigurationError("INVALID_IDEMPOTENCY_CLAIM");
          }
        }

        await requireStateGuard(() => definition.guard(context));
        const mutation = await definition.mutate(context);
        await dependencies.events.collect(transaction, mutation.events, {
          commandName: definition.name,
          correlationId: request.correlationId,
        });

        if (idempotencyIdentity !== undefined) {
          await dependencies.idempotency.complete(
            transaction,
            idempotencyIdentity,
            mutation.result,
          );
        }

        return { disposition: "EXECUTED", result: mutation.result };
      });
    },
  });
}

function criticalIdentity<
  Name extends string,
  Transaction,
  Actor,
  Input,
  State,
  Result,
  Event,
>(
  definition: CommandDefinition<
    Name,
    Transaction,
    Actor,
    Input,
    State,
    Result,
    Event
  >,
  request: CommandRequest<Actor, Input>,
): IdempotencyIdentity | undefined {
  if (!definition.critical) return undefined;
  if (
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.trim().length === 0
  ) {
    throw new MissingIdempotencyKeyError();
  }
  assertBoundedValue(request.idempotencyKey, "idempotency key");

  let scope: string;
  try {
    scope = definition.idempotencyScope({
      actor: request.actor,
      input: request.input,
    });
  } catch {
    throw new CommandConfigurationError("IDEMPOTENCY_SCOPE_ERROR");
  }
  assertBoundedValue(scope, "idempotency scope");
  return Object.freeze({
    commandName: definition.name,
    key: request.idempotencyKey,
    scope,
  });
}

async function requireAuthorization(
  evaluate: () => CommandGateDecision | Promise<CommandGateDecision>,
): Promise<void> {
  let decision: CommandGateDecision;
  try {
    decision = await evaluate();
  } catch {
    throw new CommandAuthorizationError("POLICY_ERROR", "POLICY_ERROR");
  }
  if (!isGateDecision(decision)) {
    throw new CommandAuthorizationError(
      "INVALID_DECISION",
      "INVALID_POLICY_DECISION",
    );
  }
  if (decision.effect === "DENY") {
    throw new CommandAuthorizationError("DENIED", decision.code);
  }
}

async function requireStateGuard(
  evaluate: () => CommandGateDecision | Promise<CommandGateDecision>,
): Promise<void> {
  let decision: CommandGateDecision;
  try {
    decision = await evaluate();
  } catch {
    throw new CommandStateGuardError("GUARD_ERROR", "GUARD_ERROR");
  }
  if (!isGateDecision(decision)) {
    throw new CommandStateGuardError(
      "INVALID_DECISION",
      "INVALID_GUARD_DECISION",
    );
  }
  if (decision.effect === "DENY") {
    throw new CommandStateGuardError("PRECONDITION_FAILED", decision.code);
  }
}

function isGateDecision(value: unknown): value is CommandGateDecision {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly code?: unknown;
    readonly effect?: unknown;
  };
  return (
    candidate.effect === "PERMIT" ||
    (candidate.effect === "DENY" &&
      typeof candidate.code === "string" &&
      candidate.code.length <= 128 &&
      stableIdentifier.test(candidate.code))
  );
}

function assertCommandDefinition(
  value: unknown,
): asserts value is CommandDefinition<
  string,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> {
  if (
    typeof value !== "object" ||
    value === null ||
    !(commandDefinition in value) ||
    value[commandDefinition] !== true
  ) {
    throw new CommandConfigurationError("UNTRUSTED_COMMAND_DEFINITION");
  }
}

function assertStableIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !stableIdentifier.test(value) ||
    value.length > 128
  ) {
    throw new CommandConfigurationError(`INVALID_${label.toUpperCase()}`);
  }
}

function assertBoundedValue(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256
  ) {
    throw new CommandConfigurationError(`INVALID_${label.toUpperCase()}`);
  }
}
