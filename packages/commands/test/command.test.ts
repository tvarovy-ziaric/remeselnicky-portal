import { describe, expect, it, vi } from "vitest";

import {
  CommandAuthorizationError,
  CommandStateGuardError,
  MissingIdempotencyKeyError,
  createCommandHandler,
  defineCommand,
  denyCommand,
  permitCommand,
  type CommandGateDecision,
  type CommandRequest,
  type DomainEventCollector,
  type IdempotencyIdentity,
  type IdempotencyStore,
  type TransactionRunner,
} from "../src/index.js";

interface TestTransaction {
  readonly id: number;
  readonly staged: Array<() => void>;
}

interface Actor {
  readonly id: string;
}

interface Input {
  readonly expectedRevision: number;
  readonly recordId: string;
  readonly value: string;
}

interface CurrentRecord {
  readonly ownerId: string;
  readonly phase: "EDITABLE" | "SEALED";
  readonly revision: number;
}

interface Result {
  readonly revision: number;
  readonly value: string;
}

interface Event {
  readonly eventId: string;
  readonly type: "record.changed";
}

class TestTransactionRunner implements TransactionRunner<TestTransaction> {
  readonly #serialize: boolean;
  #nextId = 0;
  #tail: Promise<void> = Promise.resolve();
  public failCommit = false;

  public constructor(serialize = false) {
    this.#serialize = serialize;
  }

  public run<ResultValue>(
    work: (transaction: TestTransaction) => Promise<ResultValue>,
  ): Promise<ResultValue> {
    return this.#serialize ? this.#runSerialized(work) : this.#run(work);
  }

  async #run<ResultValue>(
    work: (transaction: TestTransaction) => Promise<ResultValue>,
  ): Promise<ResultValue> {
    const transaction: TestTransaction = {
      id: ++this.#nextId,
      staged: [],
    };
    const result = await work(transaction);
    if (this.failCommit) throw new Error("commit failed");
    for (const commit of transaction.staged) commit();
    return result;
  }

  async #runSerialized<ResultValue>(
    work: (transaction: TestTransaction) => Promise<ResultValue>,
  ): Promise<ResultValue> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#run(work);
    } finally {
      release();
    }
  }
}

class TestIdempotencyStore implements IdempotencyStore<TestTransaction> {
  readonly #results = new Map<string, unknown>();
  public claims = 0;
  public completions = 0;

  public claim<ResultValue>(
    _transaction: TestTransaction,
    identity: IdempotencyIdentity,
  ): Promise<
    | { readonly status: "ACQUIRED" }
    | { readonly result: ResultValue; readonly status: "REPLAY" }
  > {
    this.claims += 1;
    const key = identityKey(identity);
    if (this.#results.has(key)) {
      return Promise.resolve({
        result: this.#results.get(key) as ResultValue,
        status: "REPLAY",
      });
    }
    return Promise.resolve({ status: "ACQUIRED" });
  }

  public complete<ResultValue>(
    transaction: TestTransaction,
    identity: IdempotencyIdentity,
    result: ResultValue,
  ): Promise<void> {
    this.completions += 1;
    transaction.staged.push(() =>
      this.#results.set(identityKey(identity), result),
    );
    return Promise.resolve();
  }
}

function identityKey(identity: IdempotencyIdentity): string {
  return `${identity.commandName}\u0000${identity.scope}\u0000${identity.key}`;
}

interface HarnessOptions {
  readonly authorize?: () => CommandGateDecision | Promise<CommandGateDecision>;
  readonly current?: CurrentRecord;
  readonly eventsFail?: boolean;
  readonly guard?: () => CommandGateDecision | Promise<CommandGateDecision>;
  readonly serializeTransactions?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const committedEvents: Event[] = [];
  const committedMutations: Result[] = [];
  const transactionsSeen: TestTransaction[] = [];
  const transactionRunner = new TestTransactionRunner(
    options.serializeTransactions,
  );
  const idempotency = new TestIdempotencyStore();
  const current: CurrentRecord = options.current ?? {
    ownerId: "actor-1",
    phase: "EDITABLE",
    revision: 4,
  };

  const definition = defineCommand<
    "record.apply-change",
    TestTransaction,
    Actor,
    Input,
    CurrentRecord,
    Result,
    Event
  >({
    authorize: (context) => {
      order.push("authorize");
      transactionsSeen.push(context.transaction);
      return (
        options.authorize?.() ??
        (context.actor.id === context.current.ownerId
          ? permitCommand()
          : denyCommand("actor.denied"))
      );
    },
    critical: true,
    guard: (context) => {
      order.push("guard");
      transactionsSeen.push(context.transaction);
      return (
        options.guard?.() ??
        (context.current.phase === "EDITABLE" &&
        context.current.revision === context.input.expectedRevision
          ? permitCommand()
          : denyCommand("state.stale"))
      );
    },
    idempotencyScope: ({ actor }) => `actor:${actor.id}`,
    loadCurrent: ({ transaction }) => {
      order.push("load");
      transactionsSeen.push(transaction);
      return Promise.resolve(current);
    },
    mutate: (context) => {
      order.push("mutate");
      transactionsSeen.push(context.transaction);
      const result = {
        revision: context.current.revision + 1,
        value: context.input.value,
      };
      context.transaction.staged.push(() => committedMutations.push(result));
      return Promise.resolve({
        events: [{ eventId: "event-1", type: "record.changed" as const }],
        result,
      });
    },
    name: "record.apply-change",
  });
  const events: DomainEventCollector<TestTransaction> = {
    collect: (transaction, domainEvents: readonly unknown[]) => {
      order.push("events");
      transactionsSeen.push(transaction);
      if (options.eventsFail) {
        return Promise.reject(new Error("outbox unavailable"));
      }
      transaction.staged.push(() =>
        committedEvents.push(...(domainEvents as Event[])),
      );
      return Promise.resolve();
    },
  };
  const handler = createCommandHandler(definition, {
    events,
    idempotency,
    transactions: transactionRunner,
  });

  return {
    committedEvents,
    committedMutations,
    handler,
    idempotency,
    order,
    transactionsSeen,
    transactionRunner,
  };
}

const request: CommandRequest<Actor, Input> = {
  actor: { id: "actor-1" },
  correlationId: "correlation-1",
  idempotencyKey: "key-1",
  input: { expectedRevision: 4, recordId: "record-1", value: "new" },
};

describe("domain command handler", () => {
  it("authorizes, guards, mutates, captures events and completes one transaction", async () => {
    const harness = createHarness();

    await expect(harness.handler.handle(request)).resolves.toEqual({
      disposition: "EXECUTED",
      result: { revision: 5, value: "new" },
    });

    expect(harness.order).toEqual([
      "load",
      "authorize",
      "guard",
      "mutate",
      "events",
    ]);
    expect(new Set(harness.transactionsSeen).size).toBe(1);
    expect(harness.committedMutations).toEqual([{ revision: 5, value: "new" }]);
    expect(harness.committedEvents).toEqual([
      { eventId: "event-1", type: "record.changed" },
    ]);
    expect(harness.idempotency.completions).toBe(1);
  });

  it("fails closed for a denied actor without mutation or events", async () => {
    const harness = createHarness();

    await expect(
      harness.handler.handle({ ...request, actor: { id: "actor-2" } }),
    ).rejects.toMatchObject({
      code: "actor.denied",
      failure: "DENIED",
    });
    expect(harness.order).toEqual(["load", "authorize"]);
    expect(harness.committedMutations).toEqual([]);
    expect(harness.committedEvents).toEqual([]);
    expect(harness.idempotency.completions).toBe(0);
  });

  it.each([
    ["SEALED", 4],
    ["EDITABLE", 5],
  ] as const)(
    "rejects invalid or stale authoritative state %s/%i before mutation",
    async (phase, revision) => {
      const harness = createHarness({
        current: { ownerId: "actor-1", phase, revision },
      });

      await expect(harness.handler.handle(request)).rejects.toMatchObject({
        code: "state.stale",
        failure: "PRECONDITION_FAILED",
      });
      expect(harness.committedMutations).toEqual([]);
      expect(harness.committedEvents).toEqual([]);
    },
  );

  it("rolls back mutation, events and idempotency result when commit fails", async () => {
    const harness = createHarness();
    harness.transactionRunner.failCommit = true;

    await expect(harness.handler.handle(request)).rejects.toThrow(
      "commit failed",
    );
    expect(harness.committedMutations).toEqual([]);
    expect(harness.committedEvents).toEqual([]);
    harness.transactionRunner.failCommit = false;
    await expect(harness.handler.handle(request)).resolves.toMatchObject({
      disposition: "EXECUTED",
    });
  });

  it("re-authorizes then replays without repeating a write or event", async () => {
    const harness = createHarness();
    const original = await harness.handler.handle(request);
    const orderAfterOriginal = [...harness.order];

    await expect(harness.handler.handle(request)).resolves.toEqual({
      disposition: "REPLAYED",
      result: original.result,
    });
    expect(harness.order).toEqual([...orderAfterOriginal, "load", "authorize"]);
    expect(harness.committedMutations).toHaveLength(1);
    expect(harness.committedEvents).toHaveLength(1);
    expect(harness.idempotency.claims).toBe(2);
    expect(harness.idempotency.completions).toBe(1);
  });

  it("does not let a replay bypass newly denied authorization", async () => {
    let permitted = true;
    const harness = createHarness({
      authorize: () =>
        permitted ? permitCommand() : denyCommand("capability.revoked"),
    });
    await harness.handler.handle(request);
    permitted = false;

    await expect(harness.handler.handle(request)).rejects.toMatchObject({
      code: "capability.revoked",
      failure: "DENIED",
    });
    expect(harness.committedMutations).toHaveLength(1);
    expect(harness.committedEvents).toHaveLength(1);
  });

  it("rolls back a staged mutation when durable event capture fails", async () => {
    const harness = createHarness({ eventsFail: true });

    await expect(harness.handler.handle(request)).rejects.toThrow(
      "outbox unavailable",
    );
    expect(harness.committedMutations).toEqual([]);
    expect(harness.committedEvents).toEqual([]);
    expect(harness.idempotency.completions).toBe(0);
  });

  it("serializes concurrent use of one key into execute plus replay", async () => {
    const harness = createHarness({ serializeTransactions: true });

    const results = await Promise.all([
      harness.handler.handle(request),
      harness.handler.handle(request),
    ]);

    expect(results.map((result) => result.disposition).sort()).toEqual([
      "EXECUTED",
      "REPLAYED",
    ]);
    expect(harness.committedMutations).toHaveLength(1);
    expect(harness.committedEvents).toHaveLength(1);
  });

  it("rejects a missing idempotency key before opening a transaction", async () => {
    const harness = createHarness();
    const transactionSpy = vi.spyOn(harness.transactionRunner, "run");

    await expect(
      harness.handler.handle({
        actor: request.actor,
        correlationId: request.correlationId,
        input: request.input,
      }),
    ).rejects.toBeInstanceOf(MissingIdempotencyKeyError);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("ignores pseudo-current client envelope fields and uses loaded state", async () => {
    const harness = createHarness({
      current: { ownerId: "actor-1", phase: "SEALED", revision: 4 },
    });
    const untrustedEnvelope = {
      ...request,
      current: { ownerId: "actor-1", phase: "EDITABLE", revision: 4 },
      currentTimestamp: "2099-01-01T00:00:00.000Z",
    };

    await expect(
      harness.handler.handle(untrustedEnvelope),
    ).rejects.toBeInstanceOf(CommandStateGuardError);
    expect(harness.committedMutations).toEqual([]);
    expect(harness.committedEvents).toEqual([]);
  });

  it.each([
    [
      "policy throws",
      { authorize: () => Promise.reject(new Error("private")) },
    ],
    [
      "policy returns invalid",
      { authorize: () => ({ effect: "MAYBE" }) as never },
    ],
  ] as const)("fails closed when %s", async (_label, options) => {
    const harness = createHarness(options);

    await expect(harness.handler.handle(request)).rejects.toBeInstanceOf(
      CommandAuthorizationError,
    );
    expect(harness.committedMutations).toEqual([]);
    expect(harness.committedEvents).toEqual([]);
  });

  it.each([
    ["guard throws", { guard: () => Promise.reject(new Error("private")) }],
    ["guard returns invalid", { guard: () => ({ effect: "MAYBE" }) as never }],
  ] as const)("fails closed when %s", async (_label, options) => {
    const harness = createHarness(options);

    await expect(harness.handler.handle(request)).rejects.toBeInstanceOf(
      CommandStateGuardError,
    );
    expect(harness.committedMutations).toEqual([]);
    expect(harness.committedEvents).toEqual([]);
  });
});
