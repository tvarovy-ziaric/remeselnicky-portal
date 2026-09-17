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
    MALWARE_SCANNER_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).optional(),
    MALWARE_SCANNER_PORT: portSchema.optional(),
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
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).max(256).optional(),
    OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    OBJECT_STORAGE_PRIVATE_CONTAINER: z.string().min(3).max(63).optional(),
    OBJECT_STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
    OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER: z
      .string()
      .min(3)
      .max(63)
      .optional(),
    OBJECT_STORAGE_REGION: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u)
      .optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).max(1_024).optional(),
    OBJECT_STORAGE_SIGNING_ENDPOINT: z.string().url().optional(),
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

    const storageFields = [
      "OBJECT_STORAGE_ACCESS_KEY_ID",
      "OBJECT_STORAGE_ENDPOINT",
      "OBJECT_STORAGE_PRIVATE_CONTAINER",
      "OBJECT_STORAGE_PUBLIC_BASE_URL",
      "OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER",
      "OBJECT_STORAGE_REGION",
      "OBJECT_STORAGE_SECRET_ACCESS_KEY",
    ] as const;
    const configuredStorageFields = storageFields.filter(
      (field) => environment[field] !== undefined,
    );
    if (
      configuredStorageFields.length > 0 &&
      configuredStorageFields.length !== storageFields.length
    ) {
      for (const field of storageFields) {
        if (environment[field] === undefined) {
          context.addIssue({
            code: "custom",
            message: "is required when object storage is configured",
            path: [field],
          });
        }
      }
    }

    if (
      environment.OBJECT_STORAGE_PRIVATE_CONTAINER !== undefined &&
      environment.OBJECT_STORAGE_PRIVATE_CONTAINER ===
        environment.OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER
    ) {
      context.addIssue({
        code: "custom",
        message: "must differ from the private container",
        path: ["OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER"],
      });
    }

    if (environment.APP_ENV === "development") {
      return;
    }

    if (configuredStorageFields.length !== storageFields.length) {
      context.addIssue({
        code: "custom",
        message: "is required outside development and test",
        path: ["OBJECT_STORAGE_ENDPOINT"],
      });
    }

    for (const [field, rawUrl] of [
      ["OBJECT_STORAGE_ENDPOINT", environment.OBJECT_STORAGE_ENDPOINT],
      [
        "OBJECT_STORAGE_SIGNING_ENDPOINT",
        environment.OBJECT_STORAGE_SIGNING_ENDPOINT,
      ],
      [
        "OBJECT_STORAGE_PUBLIC_BASE_URL",
        environment.OBJECT_STORAGE_PUBLIC_BASE_URL,
      ],
    ] as const) {
      const url = rawUrl === undefined ? undefined : parseUrl(rawUrl);
      if (
        url !== undefined &&
        (url.protocol !== "https:" || isLocalHostname(url.hostname))
      ) {
        context.addIssue({
          code: "custom",
          message: "must be a non-local HTTPS URL outside development and test",
          path: [field],
        });
      }
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
    if (
      environment.OBJECT_STORAGE_ACCESS_KEY_ID !== undefined &&
      isPlaceholder(environment.OBJECT_STORAGE_ACCESS_KEY_ID)
    ) {
      context.addIssue({
        code: "custom",
        message: "must not be a placeholder outside development and test",
        path: ["OBJECT_STORAGE_ACCESS_KEY_ID"],
      });
    }
    if (
      environment.OBJECT_STORAGE_SECRET_ACCESS_KEY !== undefined &&
      isPlaceholder(environment.OBJECT_STORAGE_SECRET_ACCESS_KEY)
    ) {
      context.addIssue({
        code: "custom",
        message: "must not be a placeholder outside development and test",
        path: ["OBJECT_STORAGE_SECRET_ACCESS_KEY"],
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
  readonly storage?: Readonly<{
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  }>;
}

export interface ObjectStorageServerConfig {
  readonly endpoint: string;
  readonly forcePathStyle: boolean;
  readonly privateContainer: string;
  readonly publicBaseUrl: string;
  readonly publicDerivativeContainer: string;
  readonly region: string;
  /** Optional public S3 endpoint used only when minting short-lived downloads. */
  readonly signingEndpoint?: string;
}

export interface MalwareScannerServerConfig {
  readonly host: "127.0.0.1" | "::1" | "localhost";
  readonly port: number;
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
  readonly malwareScanner: MalwareScannerServerConfig | undefined;
  readonly observability: ObservabilityContext;
  readonly objectStorage: ObjectStorageServerConfig | undefined;
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
  const objectStorage = parseObjectStorageConfig(result.data);

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
    malwareScanner:
      result.data.MALWARE_SCANNER_HOST === undefined
        ? undefined
        : Object.freeze({
            host: result.data.MALWARE_SCANNER_HOST,
            port: result.data.MALWARE_SCANNER_PORT ?? 3_310,
          }),
    observability,
    objectStorage: objectStorage?.config,
    port: result.data.PORT,
    releaseRevision: result.data.RELEASE_REVISION,
    secrets: Object.freeze({
      databaseUrl: result.data.DATABASE_URL,
      sessionSecret: result.data.SESSION_SECRET,
      ...(objectStorage === undefined
        ? {}
        : {
            storage: Object.freeze({
              accessKeyId: objectStorage.secrets.accessKeyId,
              secretAccessKey: objectStorage.secrets.secretAccessKey,
            }),
          }),
    }),
  });
}

function parseObjectStorageConfig(
  environment: z.output<typeof serverEnvironmentSchema>,
):
  | Readonly<{
      readonly config: ObjectStorageServerConfig;
      readonly secrets: Readonly<{
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
      }>;
    }>
  | undefined {
  if (
    environment.OBJECT_STORAGE_ACCESS_KEY_ID === undefined ||
    environment.OBJECT_STORAGE_ENDPOINT === undefined ||
    environment.OBJECT_STORAGE_PRIVATE_CONTAINER === undefined ||
    environment.OBJECT_STORAGE_PUBLIC_BASE_URL === undefined ||
    environment.OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER === undefined ||
    environment.OBJECT_STORAGE_REGION === undefined ||
    environment.OBJECT_STORAGE_SECRET_ACCESS_KEY === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    config: Object.freeze({
      endpoint: environment.OBJECT_STORAGE_ENDPOINT,
      forcePathStyle: environment.OBJECT_STORAGE_FORCE_PATH_STYLE,
      privateContainer: environment.OBJECT_STORAGE_PRIVATE_CONTAINER,
      publicBaseUrl: environment.OBJECT_STORAGE_PUBLIC_BASE_URL,
      publicDerivativeContainer:
        environment.OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER,
      region: environment.OBJECT_STORAGE_REGION,
      ...(environment.OBJECT_STORAGE_SIGNING_ENDPOINT === undefined
        ? {}
        : { signingEndpoint: environment.OBJECT_STORAGE_SIGNING_ENDPOINT }),
    }),
    secrets: Object.freeze({
      accessKeyId: environment.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: environment.OBJECT_STORAGE_SECRET_ACCESS_KEY,
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
