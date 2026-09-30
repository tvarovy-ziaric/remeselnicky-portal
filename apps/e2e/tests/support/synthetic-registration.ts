import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { APIResponse, Browser, BrowserContext } from "@playwright/test";
import { request as playwrightRequest } from "@playwright/test";

import { enterAlphaGateContext } from "./alpha-gate.js";

const registrationDomain = "portal.invalid";
const registrationPrefix = "synthetic.e2e";
const signatureDomain = "portal-synthetic-registration-v1\0";

export interface AuthenticatedActor {
  readonly context: BrowserContext;
  readonly csrfToken: string;
}

export interface SyntheticRegistrationFixture {
  readonly claimEmailToken: () => Promise<string>;
  readonly claimPhoneOtp: () => Promise<string>;
  readonly email: string;
  readonly password: string;
  readonly phone: string;
}

interface VerificationClaim {
  readonly channel: "EMAIL" | "PHONE";
  readonly destination: string;
}

interface SyntheticRegistrationConfiguration {
  readonly claimKey: string;
  readonly registrationKey: string;
  readonly sinkOrigin: string;
}

export async function createSyntheticRegistrationFixture(): Promise<SyntheticRegistrationFixture> {
  const configuration = await loadConfiguration();
  const email = signedSyntheticEmail(configuration.registrationKey);
  const phone = syntheticPhone();

  return Object.freeze({
    claimEmailToken: () =>
      claimDeliveredSecret(configuration, {
        channel: "EMAIL",
        destination: email,
      }),
    claimPhoneOtp: async () => {
      const otp = await claimDeliveredSecret(configuration, {
        channel: "PHONE",
        destination: phone,
      });
      if (!/^\d{6}$/u.test(otp)) {
        throw new Error(
          "Synthetic phone claim returned an invalid secret shape",
        );
      }
      return otp;
    },
    email,
    password: `D30!${randomUUID()}-${randomUUID()}`,
    phone,
  });
}

export async function registerVerifiedSyntheticCustomer(
  browser: Browser,
): Promise<AuthenticatedActor> {
  const configuration = await loadConfiguration();
  const baseURL = requiredEnvironment("STAGING_E2E_BASE_URL");
  const context = await browser.newContext({
    baseURL,
    ...accessHeaders(baseURL),
  });

  try {
    await enterAlphaGateContext(context);
    const email = signedSyntheticEmail(configuration.registrationKey);
    const password = `D30!${randomUUID()}-${randomUUID()}`;
    const anonymousCsrf = requiredString(
      (await json(await context.request.get("/v1/auth/csrf"), 200, "csrf"))[
        "csrfToken"
      ],
      "csrf token",
    );
    const registered = await json(
      await context.request.post("/v1/auth/register", {
        data: { adultAttested: true, email, password },
        headers: { "x-csrf-token": anonymousCsrf },
      }),
      201,
      "registration",
    );
    let csrfToken = requiredString(registered["csrfToken"], "csrf token");

    const emailToken = await claimDeliveredSecret(configuration, {
      channel: "EMAIL",
      destination: email,
    });
    empty(
      await context.request.post("/v1/auth/email-verification", {
        data: { token: emailToken },
        headers: { "x-csrf-token": csrfToken },
      }),
      204,
      "email verification",
    );

    const phone = syntheticPhone();
    const sent = await json(
      await context.request.post("/v1/auth/phone-verification/send", {
        data: { phone },
        headers: { "x-csrf-token": csrfToken },
      }),
      202,
      "phone verification request",
    );
    const challengeId = requiredUuid(sent["challengeId"], "phone challenge");
    const otp = await claimDeliveredSecret(configuration, {
      channel: "PHONE",
      destination: phone,
    });
    if (!/^\d{6}$/u.test(otp)) {
      throw new Error("Synthetic phone claim returned an invalid secret shape");
    }
    empty(
      await context.request.post("/v1/auth/phone-verification/verify", {
        data: { challengeId, otp },
        headers: { "x-csrf-token": csrfToken },
      }),
      204,
      "phone verification",
    );

    const session = await json(
      await context.request.get("/v1/auth/session"),
      200,
      "verified session",
    );
    const user = record(session["user"]);
    if (
      user === null ||
      user["emailVerified"] !== true ||
      user["phoneVerified"] !== true
    ) {
      throw new Error("Synthetic registration did not reach verified state");
    }
    csrfToken = requiredString(session["csrfToken"], "csrf token");
    return { context, csrfToken };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function authenticateSeededActor(
  browser: Browser,
  actor: "PROVIDER_A" | "PROVIDER_B",
): Promise<AuthenticatedActor> {
  const baseURL = requiredEnvironment("STAGING_E2E_BASE_URL");
  const storageState = process.env[`STAGING_E2E_${actor}_AUTH_STATE`];
  const context = await browser.newContext({
    baseURL,
    ...accessHeaders(baseURL),
    ...(storageState === undefined ? {} : { storageState }),
  });
  try {
    let session = await context.request.get("/v1/auth/session");
    if (session.status() === 401 && storageState === undefined) {
      const csrf = await json(
        await context.request.get("/v1/auth/csrf"),
        200,
        "csrf",
      );
      await json(
        await context.request.post("/v1/auth/login", {
          data: {
            email: requiredEnvironment(`STAGING_E2E_${actor}_EMAIL`),
            password: requiredEnvironment(`STAGING_E2E_${actor}_PASSWORD`),
          },
          headers: {
            "x-csrf-token": requiredString(csrf["csrfToken"], "csrf token"),
          },
        }),
        200,
        "synthetic provider login",
      );
      session = await context.request.get("/v1/auth/session");
    }
    const payload = await json(session, 200, "synthetic provider session");
    return {
      context,
      csrfToken: requiredString(payload["csrfToken"], "csrf token"),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function claimDeliveredSecret(
  configuration: SyntheticRegistrationConfiguration,
  claim: VerificationClaim,
): Promise<string> {
  const claimContext = await playwrightRequest.newContext({
    baseURL: configuration.sinkOrigin,
    extraHTTPHeaders: {
      authorization: `Bearer ${configuration.claimKey}`,
      "content-type": "application/json",
    },
  });
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await claimContext.post("/v1/claim", { data: claim });
      if (response.status() === 200) {
        const payload = (await response.json().catch(() => null)) as unknown;
        const secret = record(payload)?.["secret"];
        if (typeof secret !== "string" || secret.length === 0) {
          throw new Error("Synthetic verification claim has an invalid shape");
        }
        return secret;
      }
      if (response.status() !== 404) {
        throw new Error(
          `Synthetic verification claim failed with HTTP ${response.status()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(
      "Synthetic verification delivery was not claimable in time",
    );
  } finally {
    await claimContext.dispose();
  }
}

async function loadConfiguration(): Promise<SyntheticRegistrationConfiguration> {
  const registrationKey = await readSecretFile(
    "STAGING_E2E_SYNTHETIC_REGISTRATION_KEY_FILE",
  );
  const claimKey = await readSecretFile("STAGING_E2E_SYNTHETIC_CLAIM_KEY_FILE");
  const sinkOrigin = requiredEnvironment("STAGING_E2E_SYNTHETIC_SINK_ORIGIN");
  const parsed = new URL(sinkOrigin);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Synthetic verification sink origin is not loopback-only");
  }
  return { claimKey, registrationKey, sinkOrigin: parsed.origin };
}

async function readSecretFile(environmentName: string): Promise<string> {
  const path = requiredEnvironment(environmentName);
  const secret = await readFile(path, "utf8");
  if (!/^[0-9a-f]{64}$/u.test(secret)) {
    throw new Error(
      `Synthetic secret file configured by ${environmentName} is invalid`,
    );
  }
  return secret;
}

function signedSyntheticEmail(registrationKey: string): string {
  const nonce = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", registrationKey)
    .update(`${signatureDomain}${nonce}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${registrationPrefix}.${nonce}.${mac}@${registrationDomain}`;
}

function syntheticPhone(): string {
  let digits = "";
  while (digits.length < 10) {
    digits += randomBytes(8).toString("hex").replaceAll(/[a-f]/gu, "");
  }
  return `+999${digits.slice(0, 10)}`;
}

function accessHeaders(baseURL: string): Readonly<{
  extraHTTPHeaders?: Record<string, string>;
}> {
  void baseURL;
  const clientId = process.env["STAGING_E2E_CF_ACCESS_CLIENT_ID"];
  const clientSecret = process.env["STAGING_E2E_CF_ACCESS_CLIENT_SECRET"];
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error("Cloudflare Access credentials must be supplied as a pair");
  }
  if (clientId !== undefined && clientSecret !== undefined) {
    return {
      extraHTTPHeaders: {
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    };
  }
  return {};
}

async function json(
  response: APIResponse,
  expectedStatus: number,
  operation: string,
): Promise<Record<string, unknown>> {
  if (response.status() !== expectedStatus) {
    throw new Error(`${operation} failed with HTTP ${response.status()}`);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  const result = record(payload);
  if (result === null) throw new Error(`${operation} returned invalid JSON`);
  return result;
}

function empty(
  response: APIResponse,
  expectedStatus: number,
  operation: string,
): void {
  if (response.status() !== expectedStatus) {
    throw new Error(`${operation} failed with HTTP ${response.status()}`);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Synthetic ${label} is unavailable`);
  }
  return value;
}

function requiredUuid(value: unknown, label: string): string {
  const candidate = requiredString(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate,
    )
  ) {
    throw new Error(`Synthetic ${label} is malformed`);
  }
  return candidate;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing synthetic E2E configuration ${name}`);
  }
  return value;
}
