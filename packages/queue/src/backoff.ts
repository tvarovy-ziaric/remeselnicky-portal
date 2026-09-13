export interface ExponentialBackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export function exponentialBackoff(
  failedAttempt: number,
  options: ExponentialBackoffOptions,
): number {
  assertPositiveInteger(failedAttempt, "failedAttempt");
  assertPositiveInteger(options.baseDelayMs, "baseDelayMs");
  assertPositiveInteger(options.maxDelayMs, "maxDelayMs");

  if (options.baseDelayMs > options.maxDelayMs) {
    throw new RangeError("baseDelayMs must not exceed maxDelayMs");
  }

  const exponent = Math.min(failedAttempt - 1, 30);
  return Math.min(options.baseDelayMs * 2 ** exponent, options.maxDelayMs);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
