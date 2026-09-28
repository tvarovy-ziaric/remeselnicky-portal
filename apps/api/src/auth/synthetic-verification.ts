import { createHmac, timingSafeEqual } from "node:crypto";

import type { DeploymentEnvironment } from "@portal/config/public";

import type { EmailVerificationDeliveryPort } from "./email-verification.js";
import type { PhoneVerificationDeliveryPort } from "./phone-verification.js";
import type {
  AuthPersistence,
  RegistrationAdmissionPort,
  RegistrationEligibilityPort,
} from "./types.js";

const emailPattern =
  /^synthetic\.e2e\.([a-f0-9]{32})\.([a-f0-9]{32})@portal\.invalid$/u;
const phonePattern = /^\+999[0-9]{8,12}$/u;
const fixedSinkOrigin = "http://synthetic-verification-sink:8467";

export interface SyntheticVerificationRuntime {
  readonly createAdmission: (
    persistence: Pick<AuthPersistence, "register">,
  ) => RegistrationAdmissionPort;
  readonly emailDelivery: EmailVerificationDeliveryPort;
  readonly eligibility: RegistrationEligibilityPort;
  readonly phoneDelivery: PhoneVerificationDeliveryPort;
}

export function createSyntheticVerificationRuntime(input: {
  readonly environment: DeploymentEnvironment;
  readonly ingestKey: string;
  readonly registrationSigningKey: string;
  readonly sinkOrigin: string;
}): SyntheticVerificationRuntime {
  if (input.environment !== "staging" || input.sinkOrigin !== fixedSinkOrigin) {
    throw new Error("Synthetic verification is restricted to Alpha staging.");
  }
  assertSecret(input.ingestKey);
  assertSecret(input.registrationSigningKey);

  const deliver = async (body: Readonly<Record<string, string>>) => {
    let response: Response;
    try {
      response = await fetch(`${fixedSinkOrigin}/v1/deliver`, {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${input.ingestKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw new Error("Synthetic verification delivery unavailable.");
    }
    if (response.status !== 202) {
      throw new Error("Synthetic verification delivery unavailable.");
    }
  };

  const createAdmission = (
    persistence: Pick<AuthPersistence, "register">,
  ): RegistrationAdmissionPort =>
    Object.freeze({
      async register(
        registration: Parameters<RegistrationAdmissionPort["register"]>[0],
      ) {
        if (
          !isEligibleSyntheticEmail(
            registration.normalizedEmail,
            input.registrationSigningKey,
          )
        ) {
          return { status: "NOT_AVAILABLE" } as const;
        }
        return persistence.register(registration);
      },
    });

  return Object.freeze({
    createAdmission,
    emailDelivery: Object.freeze({
      async deliver({
        normalizedEmail,
        token,
      }: Parameters<EmailVerificationDeliveryPort["deliver"]>[0]) {
        if (
          !isEligibleSyntheticEmail(
            normalizedEmail,
            input.registrationSigningKey,
          )
        ) {
          throw new Error("Synthetic verification destination rejected.");
        }
        await deliver({
          channel: "EMAIL",
          destination: normalizedEmail,
          secret: token,
        });
      },
    }),
    eligibility: Object.freeze({
      isEligible({
        normalizedEmail,
      }: Parameters<RegistrationEligibilityPort["isEligible"]>[0]) {
        return Promise.resolve(
          isEligibleSyntheticEmail(
            normalizedEmail,
            input.registrationSigningKey,
          ),
        );
      },
    }),
    phoneDelivery: Object.freeze({
      async deliver({
        normalizedPhone,
        otp,
      }: Parameters<PhoneVerificationDeliveryPort["deliver"]>[0]) {
        if (!phonePattern.test(normalizedPhone)) {
          throw new Error("Synthetic verification destination rejected.");
        }
        await deliver({
          channel: "PHONE",
          destination: normalizedPhone,
          secret: otp,
        });
      },
    }),
  });
}

function isEligibleSyntheticEmail(email: string, signingKey: string): boolean {
  const match = emailPattern.exec(email);
  if (match === null) return false;
  const nonce = match[1]!;
  const supplied = Buffer.from(match[2]!, "hex");
  const expected = createHmac("sha256", signingKey)
    .update(`portal-synthetic-registration-v1\0${nonce}`, "utf8")
    .digest()
    .subarray(0, 16);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function assertSecret(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Synthetic verification configuration is invalid.");
  }
}
