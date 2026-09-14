export interface ConsumerEventIdentity {
  readonly consumerName: string;
  readonly eventId: string;
}

export interface ConsumerClaimStore<Transaction> {
  /** Must insert the claim through `transaction`; false means already applied. */
  claim(
    transaction: Transaction,
    identity: ConsumerEventIdentity,
  ): Promise<boolean>;
}

export interface ConsumerTransactionRunner<Transaction> {
  run<Result>(
    work: (transaction: Transaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface IdempotentConsumer<Transaction> {
  applyOnce<Result>(
    identity: ConsumerEventIdentity,
    effect: (transaction: Transaction) => Promise<Result>,
  ): Promise<
    | { readonly disposition: "APPLIED"; readonly result: Result }
    | { readonly disposition: "DUPLICATE" }
  >;
}

export function createIdempotentConsumer<Transaction>(dependencies: {
  readonly claims: ConsumerClaimStore<Transaction>;
  readonly transactions: ConsumerTransactionRunner<Transaction>;
}): IdempotentConsumer<Transaction> {
  return Object.freeze({
    applyOnce<Result>(
      identity: ConsumerEventIdentity,
      effect: (transaction: Transaction) => Promise<Result>,
    ) {
      validateIdentity(identity);
      return dependencies.transactions.run(async (transaction) => {
        const acquired = await dependencies.claims.claim(transaction, identity);
        if (!acquired) return { disposition: "DUPLICATE" as const };
        const result = await effect(transaction);
        return { disposition: "APPLIED" as const, result };
      });
    },
  });
}

function validateIdentity(identity: ConsumerEventIdentity): void {
  if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u.test(identity.consumerName)) {
    throw new TypeError("consumerName must be a stable machine identifier");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      identity.eventId,
    )
  ) {
    throw new TypeError("eventId must be a UUID");
  }
}
