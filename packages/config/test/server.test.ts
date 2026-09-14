import packageManifest from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { ConfigurationError, parseServerConfig } from "../src/server.js";

const productionEnvironment = {
  APP_ENV: "production",
  APP_ORIGIN: "https://portal.example",
  DATABASE_URL:
    "postgresql://portal:strong-database-password@db.example/portal?sslmode=require",
  PORT: "3001",
  RELEASE_REVISION: "git-a1b2c3d4",
  SESSION_SECRET: "s".repeat(48),
} as const;

describe("server configuration", () => {
  it("parses required values and exposes observability context", () => {
    const config = parseServerConfig(productionEnvironment);

    expect(config.environment).toBe("production");
    expect(config.adminAccess).toEqual({
      challengeTtlMs: 120_000,
      privilegedSessionTtlMs: 1_800_000,
      reauthenticationMaxAgeMs: 300_000,
    });
    expect(config.port).toBe(3_001);
    expect(config.observability).toEqual({
      environment: "production",
      releaseRevision: "git-a1b2c3d4",
    });
    expect(config.auth).toEqual({
      cookieName: "__Host-portal.sid",
      cookieSecure: true,
      passwordResetTtlMs: 3_600_000,
      phoneOtpMaxAttempts: 5,
      phoneOtpResendLimit: 3,
      phoneOtpTtlMs: 600_000,
      phoneOtpVerifyLimit: 10,
      phoneOtpWindowMs: 900_000,
      rateLimitMax: 10,
      rateLimitWindowMs: 900_000,
      sessionTtlMs: 604_800_000,
      trustProxyHops: 1,
    });
    expect(config.secrets.databaseUrl).toBe(productionEnvironment.DATABASE_URL);
  });

  it("supports bounded auth timing overrides without exposing secrets", () => {
    const config = parseServerConfig({
      ...productionEnvironment,
      AUTH_RATE_LIMIT_MAX: "5",
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "120",
      PASSWORD_RESET_TTL_SECONDS: "900",
      PHONE_OTP_MAX_ATTEMPTS: "4",
      PHONE_OTP_RESEND_LIMIT: "2",
      PHONE_OTP_TTL_SECONDS: "300",
      PHONE_OTP_VERIFY_LIMIT: "8",
      PHONE_OTP_WINDOW_SECONDS: "600",
      SESSION_TTL_SECONDS: "86400",
      ADMIN_MFA_CHALLENGE_TTL_SECONDS: "180",
      ADMIN_PRIVILEGED_SESSION_TTL_SECONDS: "3600",
      ADMIN_REAUTH_MAX_AGE_SECONDS: "600",
    });

    expect(config.auth).toMatchObject({
      passwordResetTtlMs: 900_000,
      phoneOtpMaxAttempts: 4,
      phoneOtpResendLimit: 2,
      phoneOtpTtlMs: 300_000,
      phoneOtpVerifyLimit: 8,
      phoneOtpWindowMs: 600_000,
      rateLimitMax: 5,
      rateLimitWindowMs: 120_000,
      sessionTtlMs: 86_400_000,
    });
    expect(config.adminAccess).toEqual({
      challengeTtlMs: 180_000,
      privilegedSessionTtlMs: 3_600_000,
      reauthenticationMaxAgeMs: 600_000,
    });
  });

  it.each([
    ["ADMIN_MFA_CHALLENGE_TTL_SECONDS", "59"],
    ["ADMIN_PRIVILEGED_SESSION_TTL_SECONDS", "43201"],
    ["ADMIN_REAUTH_MAX_AGE_SECONDS", "29"],
    ["AUTH_RATE_LIMIT_MAX", "0"],
    ["AUTH_RATE_LIMIT_WINDOW_SECONDS", "59"],
    ["PASSWORD_RESET_TTL_SECONDS", "86401"],
    ["PHONE_OTP_MAX_ATTEMPTS", "21"],
    ["PHONE_OTP_RESEND_LIMIT", "0"],
    ["PHONE_OTP_TTL_SECONDS", "59"],
    ["PHONE_OTP_VERIFY_LIMIT", "101"],
    ["PHONE_OTP_WINDOW_SECONDS", "3601"],
    ["SESSION_TTL_SECONDS", "not-a-number"],
  ])("rejects unsafe auth setting %s", (field, value) => {
    expect(() =>
      parseServerConfig({ ...productionEnvironment, [field]: value }),
    ).toThrow(ConfigurationError);
  });

  it("uses non-secure development cookies without trusting a proxy", () => {
    const config = parseServerConfig({
      ...productionEnvironment,
      APP_ENV: "development",
      APP_ORIGIN: "http://portal.localhost",
      DATABASE_URL: "postgresql://portal:password@localhost/portal",
      RELEASE_REVISION: "local-development",
      SESSION_SECRET: "development-session-secret-at-least-32-characters",
    });

    expect(config.auth).toMatchObject({
      cookieName: "portal.sid",
      cookieSecure: false,
      trustProxyHops: 0,
    });
  });

  it("rejects admin reauthentication windows longer than privileged sessions", () => {
    expect(() =>
      parseServerConfig({
        ...productionEnvironment,
        ADMIN_PRIVILEGED_SESSION_TTL_SECONDS: "300",
        ADMIN_REAUTH_MAX_AGE_SECONDS: "301",
      }),
    ).toThrow(/ADMIN_REAUTH_MAX_AGE_SECONDS/);
  });

  it("fails production startup when a required secret is absent", () => {
    const withoutSecret: Record<string, string | undefined> = {
      ...productionEnvironment,
    };
    delete withoutSecret.SESSION_SECRET;

    expect(() => parseServerConfig(withoutSecret)).toThrow(ConfigurationError);
    expect(() => parseServerConfig(withoutSecret)).toThrow(/SESSION_SECRET/);
  });

  it.each([
    ["an HTTP origin", { APP_ORIGIN: "http://portal.example" }],
    [
      "a local database",
      {
        DATABASE_URL:
          "postgresql://portal:password@localhost/portal?sslmode=require",
      },
    ],
    [
      "a database connection without TLS",
      {
        DATABASE_URL: "postgresql://portal:password@db.example/portal",
      },
    ],
    ["a placeholder release", { RELEASE_REVISION: "unknown" }],
  ])("rejects %s in production", (_case, override) => {
    expect(() =>
      parseServerConfig({ ...productionEnvironment, ...override }),
    ).toThrow(ConfigurationError);
  });

  it("never includes secret values in validation errors", () => {
    const unsafeSecret = "visible-but-invalid";

    try {
      parseServerConfig({
        ...productionEnvironment,
        SESSION_SECRET: unsafeSecret,
      });
      expect.unreachable("invalid configuration should throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      if (error instanceof Error) {
        expect(error.message).not.toContain(unsafeSecret);
      }
    }
  });

  it("publishes the server entry point only for Node runtimes", () => {
    const serverExport = packageManifest.exports["./server"];

    expect(serverExport).toEqual({
      types: "./dist/server.d.ts",
      node: "./dist/server.js",
    });
    expect(serverExport).not.toHaveProperty("browser");
    expect(serverExport).not.toHaveProperty("default");
    expect(serverExport).not.toHaveProperty("import");
  });
});
