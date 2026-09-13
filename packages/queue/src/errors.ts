export class RetryableJobError extends Error {
  public readonly code: string;

  public constructor(code: string, message = "Retryable job failure") {
    super(message);
    this.code = normalizeErrorCode(code);
    this.name = "RetryableJobError";
  }
}

export class NonRetryableJobError extends Error {
  public readonly code: string;

  public constructor(code: string, message = "Non-retryable job failure") {
    super(message);
    this.code = normalizeErrorCode(code);
    this.name = "NonRetryableJobError";
  }
}

export interface ClassifiedJobError {
  readonly code: string;
  readonly retryable: boolean;
}

export function classifyJobError(error: unknown): ClassifiedJobError {
  if (error instanceof NonRetryableJobError) {
    return { code: error.code, retryable: false };
  }

  if (error instanceof RetryableJobError) {
    return { code: error.code, retryable: true };
  }

  return { code: "UNEXPECTED", retryable: true };
}

function normalizeErrorCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.-]{0,63}$/.test(normalized)) {
    throw new TypeError(
      "Job error code must be a bounded machine identifier, not error detail",
    );
  }
  return normalized;
}
