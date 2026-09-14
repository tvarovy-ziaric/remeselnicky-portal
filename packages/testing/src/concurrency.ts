export interface ConcurrentAttemptContext {
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
}

export type ConcurrentAttemptClassification =
  "COMMITTED" | "IDEMPOTENT_REPLAY" | "REJECTED";

export interface ExactlyOnceEvidence<Result> {
  readonly concurrentResults: readonly Result[];
  readonly effectsAfterConcurrency: number;
  readonly effectsAfterRetry: number;
  readonly idempotencyKey: string;
  readonly retryResult: Result;
}

/** Releases all command attempts from one barrier to create a real race. */
export async function runConcurrentAttempts<Result>(input: {
  readonly attemptCount?: number;
  readonly idempotencyKey: string;
  readonly run: (context: ConcurrentAttemptContext) => Promise<Result>;
}): Promise<readonly Result[]> {
  const attemptCount = input.attemptCount ?? 2;
  assertAttemptCount(attemptCount);
  assertIdempotencyKey(input.idempotencyKey);
  let arrived = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts = Array.from({ length: attemptCount }, (_, attemptIndex) =>
    (async () => {
      arrived += 1;
      if (arrived === attemptCount) release?.();
      await barrier;
      return input.run({ attemptIndex, idempotencyKey: input.idempotencyKey });
    })(),
  );
  return Object.freeze(await Promise.all(attempts));
}

/**
 * Proves one committed effect under a race and that a later HTTP-style retry
 * with the same key cannot create a second effect.
 */
export async function verifyExactlyOnceCommand<Result>(input: {
  readonly attemptCount?: number;
  readonly classify: (result: Result) => ConcurrentAttemptClassification;
  readonly countCommittedEffects: () => Promise<number>;
  readonly idempotencyKey: string;
  readonly run: (context: ConcurrentAttemptContext) => Promise<Result>;
}): Promise<ExactlyOnceEvidence<Result>> {
  const concurrentResults = await runConcurrentAttempts(input);
  const classifications = concurrentResults.map(input.classify);
  if (!classifications.includes("COMMITTED")) {
    throw new Error(
      "Concurrent command attempts produced no committed result.",
    );
  }
  if (
    classifications.some(
      (classification) =>
        classification !== "COMMITTED" &&
        classification !== "IDEMPOTENT_REPLAY" &&
        classification !== "REJECTED",
    )
  ) {
    throw new Error("Command result classification is invalid.");
  }
  const effectsAfterConcurrency = await input.countCommittedEffects();
  if (effectsAfterConcurrency !== 1) {
    throw new Error(
      `Expected one committed effect after concurrency, observed ${effectsAfterConcurrency}.`,
    );
  }
  const retryResult = await input.run({
    attemptIndex: concurrentResults.length,
    idempotencyKey: input.idempotencyKey,
  });
  if (input.classify(retryResult) === "REJECTED") {
    throw new Error("An idempotent retry was rejected instead of replayed.");
  }
  const effectsAfterRetry = await input.countCommittedEffects();
  if (effectsAfterRetry !== 1) {
    throw new Error(
      `Expected one committed effect after retry, observed ${effectsAfterRetry}.`,
    );
  }
  return Object.freeze({
    concurrentResults,
    effectsAfterConcurrency,
    effectsAfterRetry,
    idempotencyKey: input.idempotencyKey,
    retryResult,
  });
}

function assertAttemptCount(value: number): void {
  if (!Number.isInteger(value) || value < 2 || value > 32) {
    throw new TypeError("Concurrent attempt count must be between 2 and 32.");
  }
}

function assertIdempotencyKey(value: string): void {
  if (
    value.length < 16 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]+$/u.test(value)
  ) {
    throw new TypeError(
      "Test idempotency key must be bounded and machine-safe.",
    );
  }
}
