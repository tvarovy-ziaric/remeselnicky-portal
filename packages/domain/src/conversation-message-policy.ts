export const CONVERSATION_MESSAGE_POLICY_VERSION = 1;
export const CONVERSATION_MESSAGE_POLICY_STAGES = Object.freeze([
  "PRE_CONFIRM",
  "POST_CONFIRM",
] as const);
export const CONVERSATION_MESSAGE_POLICY_VIOLATIONS = Object.freeze([
  "EMAIL",
  "PHONE",
  "CONTACT_SCHEME",
  "SOCIAL_CONTACT",
  "POSTAL_ADDRESS",
  "COORDINATES",
] as const);

export type ConversationMessagePolicyStage =
  (typeof CONVERSATION_MESSAGE_POLICY_STAGES)[number];
export type ConversationMessagePolicyViolation =
  (typeof CONVERSATION_MESSAGE_POLICY_VIOLATIONS)[number];

export type ConversationMessagePolicyDecision = Readonly<
  | { readonly status: "ALLOW" }
  | {
      readonly status: "BLOCK";
      readonly violation: ConversationMessagePolicyViolation;
    }
>;

/**
 * Pure detector shared by server command handling and its test corpus. The
 * database independently mirrors these obvious-pattern rules so direct SQL
 * cannot bypass the pre-confirmation boundary.
 */
export function evaluateConversationMessagePolicy(input: {
  readonly body: string;
  readonly stage: ConversationMessagePolicyStage;
}): ConversationMessagePolicyDecision {
  if (typeof input.body !== "string") throw invalid("body");
  if (!CONVERSATION_MESSAGE_POLICY_STAGES.includes(input.stage)) {
    throw invalid("stage");
  }
  if (input.stage === "POST_CONFIRM") {
    return Object.freeze({ status: "ALLOW" });
  }

  const body = input.body
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060]/gu, "");
  for (const [violation, expressions] of policyExpressions) {
    if (expressions.some((expression) => expression.test(body))) {
      return Object.freeze({ status: "BLOCK", violation });
    }
  }
  return Object.freeze({ status: "ALLOW" });
}

const policyExpressions: ReadonlyArray<
  readonly [ConversationMessagePolicyViolation, readonly RegExp[]]
> = [
  [
    "CONTACT_SCHEME",
    [
      /(?:^|[^\p{L}\d])(?:mailto|tel)\s*:/iu,
      /https?:\/\/(?:www\.)?wa\.me(?:[/?#]|$)/iu,
    ],
  ],
  [
    "EMAIL",
    [
      /[\p{L}\d._%+-]{1,64}\s*@\s*[\p{L}\d-]+(?:\s*\.\s*[\p{L}\d-]+)+/iu,
      /[\p{L}\d._%+-]{1,64}\s*(?:\(at\)|\[at\]|zavin[aá]č)\s*[\p{L}\d-]+(?:\s*(?:\.|\(dot\)|\[dot\]|bodka)\s*[\p{L}\d-]+)+/iu,
    ],
  ],
  [
    "PHONE",
    [
      /(?:^|[^\d])(?:\+|00)?\d(?:[\s()/-]*\d){6,}(?:[^\d]|$)/u,
      /\b(?:telef[oó]n|tel\.?|mobil|volaj|zavolaj|whatsapp|viber)\b[^\d\n]{0,20}\d(?:[\s()./-]*\d){4,}/iu,
    ],
  ],
  [
    "SOCIAL_CONTACT",
    [
      /https?:\/\/(?:www\.)?(?:m\.me|t\.me|signal\.me)\/[\p{L}\d._%+~@-]+/iu,
      /https?:\/\/(?:www\.)?instagram\.com\/(?!(?:p|reel|explore|business)\/)[\p{L}\d._-]{2,}(?:[/?#]|$)/iu,
      /https?:\/\/(?:www\.)?facebook\.com\/(?!(?:business|help|groups|watch|marketplace)\/)(?:profile\.php\?id=\d+|[\p{L}\d._-]{2,})(?:[/?#]|$)/iu,
      /\b(?:instagram(?:e)?|insta|ig|facebook(?:u)?|fb|messenger(?:i)?|telegram(?:e)?|signal(?:e)?|whatsapp(?:e)?|viber(?:e)?|tiktok(?:u)?)\b[^\n]{0,30}(?:@[\p{L}\d._-]{2,}|(?:profil|profile|meno|username|nick)\s*[:=-]?\s*[\p{L}\d._-]{2,}|[:=-]\s*[\p{L}\d._-]{2,})/iu,
    ],
  ],
  [
    "POSTAL_ADDRESS",
    [
      /\b(?:psč|psc)\b[^\d\n]{0,12}\d{3}\s?\d{2}\b/iu,
      /(?:^|[^\d])\d{3}\s\d{2}(?:[^\d]|$)/u,
      /(?:^|[^\p{L}\d_])(?:adresa|ulica|námestie|namestie|trieda|číslo\s+(?:domu|bytu)|cislo\s+(?:domu|bytu)|súpisné\s+číslo|supisne\s+cislo|ul\.|nám\.|nam\.)(?:[^\p{L}\d_]|$)[^\n]{0,80}\d{1,5}(?:\s*\/\s*\d{1,5})?/iu,
    ],
  ],
  [
    "COORDINATES",
    [
      /(?:^|[^\d])[-+]?\d{1,3}[.,]\d{4,}\s*[,;/]\s*[-+]?\d{1,3}[.,]\d{4,}(?:[^\d]|$)/u,
      /\d{1,3}\s*°\s*\d{1,2}(?:[.,]\d+)?\s*[′']\s*(?:\d{1,2}(?:[.,]\d+)?\s*[″"]\s*)?[NSEW]/iu,
    ],
  ],
];

function invalid(field: string): TypeError {
  return new TypeError(`Invalid conversation message policy field: ${field}.`);
}
