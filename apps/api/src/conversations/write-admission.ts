import { createHash } from "node:crypto";

export type ConversationWriteAction =
  "ATTACHMENT_UPLOAD" | "MESSAGE_SEND" | "PARTICIPANT_STATE" | "REPORT";

export interface ConversationWriteAdmission {
  admit(input: {
    readonly action: ConversationWriteAction;
    readonly actorUserId: string;
    readonly ip: string;
  }): Promise<"ADMITTED" | "RATE_LIMITED">;
}

export interface ConversationWriteRateLimitPersistence {
  consumeRateLimit(input: {
    readonly keyDigest: string;
    readonly limit: number;
    readonly now: Date;
    readonly scope: string;
    readonly timeWindowMs: number;
  }): Promise<{ readonly current: number }>;
}

/** A looser IP ceiling avoids one actor rotating IPs without punishing NATs. */
export const CONVERSATION_WRITE_IP_LIMIT_MULTIPLIER = 5;

type AdmissionInput = Parameters<ConversationWriteAdmission["admit"]>[0];

export function createDatabaseConversationWriteAdmission(input: {
  readonly accountLimit: number;
  readonly clock?: () => Date;
  readonly persistence: ConversationWriteRateLimitPersistence;
  readonly timeWindowMs: number;
}): ConversationWriteAdmission {
  if (!Number.isSafeInteger(input.accountLimit) || input.accountLimit < 1) {
    throw new RangeError("conversation account write limit must be positive");
  }
  if (!Number.isSafeInteger(input.timeWindowMs) || input.timeWindowMs < 1) {
    throw new RangeError("conversation write window must be positive");
  }
  const clock = input.clock ?? (() => new Date());
  return Object.freeze({
    async admit(request: AdmissionInput) {
      if (
        !uuid(request.actorUserId) ||
        typeof request.ip !== "string" ||
        request.ip.length < 1 ||
        request.ip.length > 256 ||
        /[\p{Cc}]/u.test(request.ip) ||
        ![
          "ATTACHMENT_UPLOAD",
          "MESSAGE_SEND",
          "PARTICIPANT_STATE",
          "REPORT",
        ].includes(request.action)
      ) {
        throw new TypeError("conversation write admission input is invalid");
      }
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
        throw new TypeError("conversation write admission clock is invalid");
      }
      const routeKey = `conversation:${request.action}`;
      const [account, ip] = await Promise.all([
        input.persistence.consumeRateLimit({
          keyDigest: digest(
            `${routeKey}\u0000account\u0000${request.actorUserId}`,
          ),
          limit: input.accountLimit,
          now,
          scope: "conversation-write:account",
          timeWindowMs: input.timeWindowMs,
        }),
        input.persistence.consumeRateLimit({
          keyDigest: digest(`${routeKey}\u0000ip\u0000${request.ip}`),
          limit: input.accountLimit * CONVERSATION_WRITE_IP_LIMIT_MULTIPLIER,
          now,
          scope: "conversation-write:ip",
          timeWindowMs: input.timeWindowMs,
        }),
      ]);
      if (
        !Number.isSafeInteger(account.current) ||
        account.current < 1 ||
        !Number.isSafeInteger(ip.current) ||
        ip.current < 1
      ) {
        throw new TypeError("conversation write admission result is invalid");
      }
      return account.current > input.accountLimit ||
        ip.current > input.accountLimit * CONVERSATION_WRITE_IP_LIMIT_MULTIPLIER
        ? "RATE_LIMITED"
        : "ADMITTED";
    },
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
