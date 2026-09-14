import { z } from "zod";

import {
  deploymentEnvironmentSchema,
  type DeploymentEnvironment,
} from "./public.js";

const portSchema = z
  .string()
  .regex(/^\d+$/, "must be an integer between 1 and 65535")
  .transform(Number)
  .refine((port) => port >= 1 && port <= 65_535, {
    message: "must be an integer between 1 and 65535",
  });

function boundedIntegerEnvironmentValue(
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  return z
    .string()
    .regex(/^\d+$/, `must be an integer between ${minimum} and ${maximum}`)
    .transform(Number)
    .refine((value) => value >= minimum && value <= maximum, {
      message: `must be an integer between ${minimum} and ${maximum}`,
    })
    .optional()
    .transform((value) => value ?? defaultValue);
}

const serverEnvironmentSchema = z
  .object({
    APP_ENV: deploymentEnvironmentSchema,
    APP_ORIGIN: z.string().url(),
    ADMIN_MFA_CHALLENGE_TTL_SECONDS: boundedIntegerEnvironmentValue(
      120,
      60,
      600,
    ),
    ADMIN_PRIVILEGED_SESSION_TTL_SECONDS: boundedIntegerEnvironmentValue(
      1_800,
      300,
      43_200,
    ),
    ADMIN_REAUTH_MAX_AGE_SECONDS: boundedIntegerEnvironmentValue(
      300,
      30,
      3_600,
    ),
    AUTH_RATE_LIMIT_MAX: boundedIntegerEnvironmentValue(10, 1, 100),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: boundedIntegerEnvironmentValue(
      900,
      60,
      3_600,
    ),
    DATABASE_URL: z.string().min(1),
    PASSWORD_RESET_TTL_SECONDS: boundedIntegerEnvironmentValue(
      3_600,
      300,
      86_400,
    ),
    PHONE_OTP_MAX_ATTEMPTS: boundedIntegerEnvironmentValue(5, 1, 20),
    PHONE_OTP_RESEND_LIMIT: boundedIntegerEnvironmentValue(3, 1, 20),
    PHONE_OTP_TTL_SECONDS: boundedIntegerEnvironmentValue(600, 60, 3_600),
    PHONE_OTP_VERIFY_LIMIT: boundedIntegerEnvironmentValue(10, 1, 100),
    PHONE_OTP_WINDOW_SECONDS: boundedIntegerEnvironmentValue(900, 60, 3_600),
    PORT: portSchema.optional(),
    RELEASE_REVISION: z.string().trim().min(1),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_SECONDS: boundedIntegerEnvironmentValue(
      604_800,
      300,
      2_592_000,
    ),
  })
  .superRefine((environment, context) => {
    const databaseUrl = parseUrl(environment.DATABASE_URL);

    if (
      databaseUrl === undefined ||
      (databaseUrl.protocol !== "postgres:" &&
        databaseUrl.protocol !== "postgresql:")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a PostgreSQL URL",
        path: ["DATABASE_URL"],
      });
    }

    if (
      environment.ADMIN_REAUTH_MAX_AGE_SECONDS >
      environment.ADMIN_PRIVILEGED_SESSION_TTL_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        message: "must not exceed the privileged session lifetime",
        path: ["ADMIN_REAUTH_MAX_AGE_SECONDS"],
      });
    }

    if (environment.APP_ENV !== "production") {
      return;
    }

    const appOrigin = parseUrl(environment.APP_ORIGIN);
    if (
      appOrigin === undefined ||
      appOrigin.protocol !== "https:" ||
      isLocalHostname(appOrigin.hostname)
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a non-local HTTPS URL in production",
        path: ["APP_ORIGIN"],
      });
    }

    if (
      databaseUrl !== undefined &&
      (isLocalHostname(databaseUrl.hostname) || !usesTls(databaseUrl))
    ) {
      context.addIssue({
        code: "custom",
        message: "must use a non-local TLS connection in production",
        path: ["DATABASE_URL"],
      });
    }

    if (isPlaceholder(environment.RELEASE_REVISION)) {
      context.addIssue({
        code: "custom",
        message: "must identify the deployed production revision",
        path: ["RELEASE_REVISION"],
      });
    }

    if (isPlaceholder(environment.SESSION_SECRET)) {
      context.addIssue({
        code: "custom",
        message: "must not be a placeholder in production",
        path: ["SESSION_SECRET"],
      });
    }
  });

const placeholderValues = new Set([
  "change-me",
  "changeme",
  "development",
  "example",
  "local",
  "password",
  "replace-me",
  "secret",
  "unknown",
]);

export interface ObservabilityContext {
  readonly environment: DeploymentEnvironment;
  readonly releaseRevision: string;
}

export interface ServerSecrets {
  readonly databaseUrl: string;
  readonly sessionSecret: string;
}

export interface AuthServerConfig {
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly passwordResetTtlMs: number;
  readonly phoneOtpMaxAttempts: number;
  readonly phoneOtpResendLimit: number;
  readonly phoneOtpTtlMs: number;
  readonly phoneOtpVerifyLimit: number;
  readonly phoneOtpWindowMs: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly sessionTtlMs: number;
  readonly trustProxyHops: number;
}

export interface AdminAccessServerConfig {
  readonly challengeTtlMs: number;
  readonly privilegedSessionTtlMs: number;
  readonly reauthenticationMaxAgeMs: number;
}

export interface ServerConfig {
  readonly adminAccess: AdminAccessServerConfig;
  readonly appOrigin: string;
  readonly auth: AuthServerConfig;
  readonly environment: DeploymentEnvironment;
  readonly observability: ObservabilityContext;
  readonly port: number | undefined;
  readonly releaseRevision: string;
  readonly secrets: ServerSecrets;
}

export class ConfigurationError extends Error {
  public constructor(issues: readonly z.core.$ZodIssue[]) {
    const details = issues
      .map((issue) => {
        const field =
          issue.path.length === 0 ? "environment" : issue.path.join(".");
        return `${field}: ${issue.message}`;
      })
      .join("; ");

    super(`Invalid server configuration: ${details}`);
    this.name = "ConfigurationError";
  }
}

export function parseServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const result = serverEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  const observability = Object.freeze({
    environment: result.data.APP_ENV,
    releaseRevision: result.data.RELEASE_REVISION,
  });

  return Object.freeze({
    adminAccess: Object.freeze({
      challengeTtlMs: result.data.ADMIN_MFA_CHALLENGE_TTL_SECONDS * 1_000,
      privilegedSessionTtlMs:
        result.data.ADMIN_PRIVILEGED_SESSION_TTL_SECONDS * 1_000,
      reauthenticationMaxAgeMs:
        result.data.ADMIN_REAUTH_MAX_AGE_SECONDS * 1_000,
    }),
    appOrigin: result.data.APP_ORIGIN,
    auth: Object.freeze({
      cookieName:
        result.data.APP_ENV === "production"
          ? "__Host-portal.sid"
          : "portal.sid",
      cookieSecure: result.data.APP_ENV !== "development",
      passwordResetTtlMs: result.data.PASSWORD_RESET_TTL_SECONDS * 1_000,
      phoneOtpMaxAttempts: result.data.PHONE_OTP_MAX_ATTEMPTS,
      phoneOtpResendLimit: result.data.PHONE_OTP_RESEND_LIMIT,
      phoneOtpTtlMs: result.data.PHONE_OTP_TTL_SECONDS * 1_000,
      phoneOtpVerifyLimit: result.data.PHONE_OTP_VERIFY_LIMIT,
      phoneOtpWindowMs: result.data.PHONE_OTP_WINDOW_SECONDS * 1_000,
      rateLimitMax: result.data.AUTH_RATE_LIMIT_MAX,
      rateLimitWindowMs: result.data.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1_000,
      sessionTtlMs: result.data.SESSION_TTL_SECONDS * 1_000,
      trustProxyHops: result.data.APP_ENV === "development" ? 0 : 1,
    }),
    environment: result.data.APP_ENV,
    observability,
    port: result.data.PORT,
    releaseRevision: result.data.RELEASE_REVISION,
    secrets: Object.freeze({
      databaseUrl: result.data.DATABASE_URL,
      sessionSecret: result.data.SESSION_SECRET,
    }),
  });
}

/** The only configuration entry point that reads the host process environment. */
export function loadServerConfig(): ServerConfig {
  return parseServerConfig(process.env);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function usesTls(databaseUrl: URL): boolean {
  const sslMode = databaseUrl.searchParams.get("sslmode")?.toLowerCase();
  const ssl = databaseUrl.searchParams.get("ssl")?.toLowerCase();

  return (
    ssl === "true" ||
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full"
  );
}

function isPlaceholder(value: string): boolean {
  return placeholderValues.has(value.trim().toLowerCase());
}
