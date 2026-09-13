export interface TransactionRunner<Transaction> {
  /**
   * Commits only if work resolves. Implementations must roll back every write
   * made through `transaction` when work or commit rejects.
   */
  run<Result>(
    work: (transaction: Transaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface IdempotencyIdentity {
  readonly commandName: string;
  readonly key: string;
  /** Trusted actor/tenant scope, never a client-provided ownership claim. */
  readonly scope: string;
}

export type IdempotencyClaim<Result> =
  | { readonly status: "ACQUIRED" }
  | { readonly result: Result; readonly status: "REPLAY" };

export interface IdempotencyStore<Transaction> {
  /**
   * Atomically claims the identity or returns the committed original result.
   * Concurrent callers for one identity must serialize until this is knowable.
   */
  claim<Result>(
    transaction: Transaction,
    identity: IdempotencyIdentity,
  ): Promise<IdempotencyClaim<Result>>;
  complete<Result>(
    transaction: Transaction,
    identity: IdempotencyIdentity,
    result: Result,
  ): Promise<void>;
}

export interface CommandEventContext {
  readonly commandName: string;
  readonly correlationId: string;
}

export interface DomainEventCollector<Transaction> {
  /** Durably appends every event inside the supplied command transaction. */
  collect<Event>(
    transaction: Transaction,
    events: readonly Event[],
    context: CommandEventContext,
  ): Promise<void>;
}

/** Alias for adapters that call their durable collector an outbox writer. */
export type OutboxWriter<Transaction> = DomainEventCollector<Transaction>;
