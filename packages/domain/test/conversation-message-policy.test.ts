import { describe, expect, it } from "vitest";

import {
  CONVERSATION_MESSAGE_POLICY_VERSION,
  evaluateConversationMessagePolicy,
} from "../src/index.js";

describe("conversation message contact/address policy", () => {
  it.each([
    ["EMAIL", "Napíš na meno@example.sk"],
    ["EMAIL", "meno (at) example (dot) sk"],
    ["EMAIL", "meno zavináč example bodka sk"],
    ["EMAIL", "ｍｅｎｏ＠ｅｘａｍｐｌｅ．ｓｋ"],
    ["PHONE", "Volaj +421 900 123 456"],
    ["PHONE", "telefón: 0900 123 456"],
    ["CONTACT_SCHEME", "mailto:meno@example.sk"],
    ["CONTACT_SCHEME", "tel:+421900123456"],
    ["CONTACT_SCHEME", "https://wa.me/421900123456"],
    ["SOCIAL_CONTACT", "Instagram @moj_profil"],
    ["SOCIAL_CONTACT", "Som na Instagrame @majster_test"],
    ["SOCIAL_CONTACT", "IG: moj_profil"],
    ["SOCIAL_CONTACT", "FB @majster_test"],
    ["SOCIAL_CONTACT", "Telegram meno: majster123"],
    ["SOCIAL_CONTACT", "https://instagram.com/majster123"],
    ["POSTAL_ADDRESS", "PSČ je 811 01"],
    ["POSTAL_ADDRESS", "Pošlite to na 811 01"],
    ["POSTAL_ADDRESS", "Adresa: Hlavná 12"],
    ["POSTAL_ADDRESS", "ul. Jarná 12/4"],
    ["COORDINATES", "Stretneme sa na 48.1486, 17.1077"],
    ["COORDINATES", `48° 8' 55" N, 17° 6' 28" E`],
  ] as const)("blocks %s before confirmation", (violation, body) => {
    expect(
      evaluateConversationMessagePolicy({ body, stage: "PRE_CONFIRM" }),
    ).toEqual({ status: "BLOCK", violation });
  });

  it.each([
    "Napätie je 230/400 V.",
    "Potrubie má závit 1/2 palca.",
    "Rozmer je 120 × 80 cm.",
    "Prídem 15. 9. 2026 o 08:30.",
    "Číslo zákazky je 123456.",
    "Pozrite technický list https://example.org/material.pdf",
    "Výrobca: https://signal.eu/products/izolacia",
    "Materiál je na https://facebook.com/business/help/article",
    "Dokument je na https://instagram.com.evil.example/material.pdf",
  ])("allows ordinary technical text: %s", (body) => {
    expect(
      evaluateConversationMessagePolicy({ body, stage: "PRE_CONFIRM" }),
    ).toEqual({ status: "ALLOW" });
  });

  it("allows contact details only after a server-derived confirmation stage", () => {
    expect(
      evaluateConversationMessagePolicy({
        body: "Kontakt je meno@example.sk, +421 900 123 456.",
        stage: "POST_CONFIRM",
      }),
    ).toEqual({ status: "ALLOW" });
    expect(CONVERSATION_MESSAGE_POLICY_VERSION).toBe(1);
  });

  it("rejects an unknown stage rather than opening the boundary", () => {
    expect(() =>
      evaluateConversationMessagePolicy({
        body: "Dobrý deň",
        stage: "UNKNOWN" as "PRE_CONFIRM",
      }),
    ).toThrow(TypeError);
  });
});
