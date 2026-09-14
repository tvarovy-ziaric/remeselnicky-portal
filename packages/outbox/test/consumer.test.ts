import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createIdempotentConsumer,
  type ConsumerClaimStore,
  type ConsumerTransactionRunner,
} from "../src/index.js";

interface TestTransaction {
  claims: Set<string>;
  effects: string[];
}

class TransactionRunner implements ConsumerTransactionRunner<TestTransaction> {
  public readonly committed: TestTransaction = {
    claims: new Set(),
    effects: [],
  };

  public async run<Result>(
    work: (transaction: TestTransaction) => Promise<Result>,
  ): Promise<Result> {
    const transaction = {
      claims: new Set(this.committed.claims),
      effects: [...this.committed.effects],
    };
    const result = await work(transaction);
    this.committed.claims = transaction.claims;
    this.committed.effects = transaction.effects;
    return result;
  }
}

const claims: ConsumerClaimStore<TestTransaction> = {
  claim(transaction, identity) {
    const key = `${identity.consumerName}:${identity.eventId}`;
    if (transaction.claims.has(key)) return Promise.resolve(false);
    transaction.claims.add(key);
    return Promise.resolve(true);
  },
};

describe("idempotent consumer", () => {
  it("applies duplicate delivery only once", async () => {
    const transactions = new TransactionRunner();
    const consumer = createIdempotentConsumer({ claims, transactions });
    const identity = { consumerName: "notifications", eventId: randomUUID() };
    const effect = (transaction: TestTransaction) => {
      transaction.effects.push("notification-created");
      return Promise.resolve("ok");
    };

    await expect(consumer.applyOnce(identity, effect)).resolves.toEqual({
      disposition: "APPLIED",
      result: "ok",
    });
    await expect(consumer.applyOnce(identity, effect)).resolves.toEqual({
      disposition: "DUPLICATE",
    });
    expect(transactions.committed.effects).toEqual(["notification-created"]);
  });

  it("rolls back the claim when the consumer effect fails", async () => {
    const transactions = new TransactionRunner();
    const consumer = createIdempotentConsumer({ claims, transactions });
    const identity = { consumerName: "analytics", eventId: randomUUID() };

    await expect(
      consumer.applyOnce(identity, () => Promise.reject(new Error("fail"))),
    ).rejects.toThrow("fail");
    await expect(
      consumer.applyOnce(identity, (transaction) => {
        transaction.effects.push("conversion-counted");
        return Promise.resolve();
      }),
    ).resolves.toMatchObject({ disposition: "APPLIED" });
  });
});
