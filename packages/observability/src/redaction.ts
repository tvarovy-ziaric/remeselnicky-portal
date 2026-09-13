const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";
const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 2_048;

const sensitiveKeys = new Set([
  "address",
  "apikey",
  "authorization",
  "body",
  "chat",
  "connectionstring",
  "content",
  "cookie",
  "databaseurl",
  "dburl",
  "description",
  "dispute",
  "document",
  "email",
  "exactaddress",
  "file",
  "message",
  "newpassword",
  "otp",
  "passphrase",
  "password",
  "passwordhash",
  "payload",
  "pdf",
  "phone",
  "phonenumber",
  "review",
  "resettoken",
  "secret",
  "session",
  "sessionid",
  "sessionsecret",
  "setcookie",
  "signedurl",
  "token",
]);

const emailPattern = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/gu;
const databaseUrlPattern = /\bpostgres(?:ql)?:\/\/[^\s]+/giu;
const credentialHeaderPattern = /\b(?:basic|bearer)\s+[A-Za-z0-9+/._~=-]+/giu;
const phonePattern = /(?<![\w-])\+?\d(?:[ ()-]?\d){7,14}(?![\w-])/gu;
const signedUrlPattern =
  /https?:\/\/[^\s]+[?&](?:X-Amz-|Signature=|token=|sig=)[^\s]*/giu;

export function redactTelemetryValue(value: unknown): unknown {
  return redact(value, new WeakSet<object>(), 0);
}

export function sanitizeTelemetryString(value: string): string {
  return value
    .slice(0, MAX_STRING_LENGTH)
    .replace(databaseUrlPattern, REDACTED)
    .replace(credentialHeaderPattern, REDACTED)
    .replace(signedUrlPattern, REDACTED)
    .replace(emailPattern, REDACTED)
    .replace(phonePattern, REDACTED);
}

function redact(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (typeof value === "string") return sanitizeTelemetryString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return `[${typeof value}]`;
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return CIRCULAR;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redact(entry, ancestors, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = isSensitiveKey(key)
        ? REDACTED
        : redact(entry, ancestors, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (sensitiveKeys.has(normalized)) return true;
  return (
    normalized.endsWith("password") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("email") ||
    normalized.endsWith("phone") ||
    normalized.endsWith("address") ||
    normalized.endsWith("databaseurl")
  );
}
