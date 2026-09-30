import {
  AUTH_API_PATHS,
  AUTH_INPUT_LIMITS,
  type AuthErrorCode,
} from "@portal/contracts";
import { isUserAccountState, type UserAccountState } from "@portal/domain";

export interface AuthOnboardingSession {
  readonly csrfToken: string;
  readonly user: {
    readonly accountState: UserAccountState;
    readonly adultAttestedAt: string;
    readonly emailVerified: boolean;
    readonly id: string;
    readonly phoneVerified: boolean;
  };
}

type SessionResult = Readonly<
  | { readonly session: AuthOnboardingSession; readonly status: "READY" }
  | {
      readonly status:
        "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" | "UNAVAILABLE";
    }
>;

type RegistrationResult = Readonly<
  | {
      readonly session: AuthOnboardingSession;
      readonly status: "REGISTERED";
    }
  | {
      readonly status:
        | "INVALID_REQUEST"
        | "RATE_LIMITED"
        | "REGISTRATION_NOT_AVAILABLE"
        | "UNAVAILABLE";
    }
>;

type LoginResult = Readonly<
  | {
      readonly session: AuthOnboardingSession;
      readonly status: "AUTHENTICATED";
    }
  | {
      readonly status: "INVALID_CREDENTIALS" | "RATE_LIMITED" | "UNAVAILABLE";
    }
>;

type MutationResult<Success extends string> = Readonly<
  | { readonly status: Success }
  | {
      readonly status:
        | "ACCOUNT_NOT_ACTIVE"
        | "AUTHENTICATION_REQUIRED"
        | "INVALID_OR_EXPIRED"
        | "INVALID_REQUEST"
        | "RATE_LIMITED"
        | "UNAVAILABLE";
    }
>;

export interface AuthOnboardingClient {
  confirmEmail(token: string): Promise<MutationResult<"VERIFIED">>;
  loadSession(): Promise<SessionResult>;
  logout(csrfToken: string): Promise<MutationResult<"SIGNED_OUT">>;
  login(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<LoginResult>;
  register(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<RegistrationResult>;
  resendEmail(csrfToken: string): Promise<MutationResult<"SENT">>;
  sendPhone(input: {
    readonly csrfToken: string;
    readonly phone: string;
  }): Promise<
    | { readonly challengeId: string; readonly status: "SENT" }
    | Exclude<MutationResult<"SENT">, { readonly status: "SENT" }>
  >;
  verifyPhone(input: {
    readonly challengeId: string;
    readonly csrfToken: string;
    readonly otp: string;
  }): Promise<MutationResult<"VERIFIED">>;
}

const errorCodes = new Set<AuthErrorCode>([
  "ACCOUNT_NOT_ACTIVE",
  "AUTHENTICATION_REQUIRED",
  "CSRF_INVALID",
  "HANDOFF_CONFLICT",
  "HANDOFF_UNAVAILABLE",
  "INTERNAL_ERROR",
  "INVALID_CREDENTIALS",
  "INVALID_OR_EXPIRED_RESET",
  "INVALID_OR_EXPIRED_VERIFICATION",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "REGISTRATION_NOT_AVAILABLE",
  "TEMPORARILY_UNAVAILABLE",
]);

export function parseAuthSessionResponse(
  value: unknown,
): AuthOnboardingSession | null {
  if (!exactRecord(value, ["csrfToken", "user"]) || !csrf(value.csrfToken)) {
    return null;
  }
  const user = value.user;
  if (
    !exactRecord(user, [
      "accountState",
      "adultAttestedAt",
      "emailVerified",
      "id",
      "phoneVerified",
    ]) ||
    !isUserAccountState(user.accountState) ||
    !isoDate(user.adultAttestedAt) ||
    typeof user.emailVerified !== "boolean" ||
    !uuid(user.id) ||
    typeof user.phoneVerified !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    csrfToken: value.csrfToken,
    user: Object.freeze({
      accountState: user.accountState,
      adultAttestedAt: user.adultAttestedAt,
      emailVerified: user.emailVerified,
      id: user.id,
      phoneVerified: user.phoneVerified,
    }),
  });
}

export function createAuthOnboardingClient(
  input: {
    readonly fetch?: typeof fetch;
  } = {},
): AuthOnboardingClient {
  const fetcher = input.fetch ?? fetch;

  async function loadSession(): Promise<SessionResult> {
    try {
      const response = await fetcher(AUTH_API_PATHS.session, readOptions());
      if (response.status === 401) {
        return Object.freeze({ status: "AUTHENTICATION_REQUIRED" as const });
      }
      if (response.status === 403) {
        return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
      }
      const session = parseAuthSessionResponse(await response.json());
      return response.ok && session !== null
        ? Object.freeze({ session, status: "READY" as const })
        : Object.freeze({ status: "UNAVAILABLE" as const });
    } catch {
      return Object.freeze({ status: "UNAVAILABLE" as const });
    }
  }

  const client: AuthOnboardingClient = {
    async confirmEmail(token) {
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) {
        return Object.freeze({ status: "INVALID_OR_EXPIRED" as const });
      }
      try {
        const csrfToken = await getCsrf(fetcher);
        if (csrfToken === null)
          return Object.freeze({ status: "UNAVAILABLE" as const });
        const response = await fetcher(
          AUTH_API_PATHS.emailVerification,
          writeOptions(csrfToken, { token }),
        );
        if (response.status === 204)
          return Object.freeze({ status: "VERIFIED" as const });
        return mutationFailure(await errorCode(response));
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    loadSession,
    async logout(csrfToken) {
      if (!csrf(csrfToken))
        return Object.freeze({ status: "UNAVAILABLE" as const });
      try {
        const response = await fetcher(
          AUTH_API_PATHS.logout,
          writeOptions(csrfToken),
        );
        return response.status === 204
          ? Object.freeze({ status: "SIGNED_OUT" as const })
          : mutationFailure(await errorCode(response));
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async login(credentials) {
      if (!validCredentials(credentials))
        return Object.freeze({ status: "UNAVAILABLE" as const });
      try {
        const csrfToken = await getCsrf(fetcher);
        if (csrfToken === null)
          return Object.freeze({ status: "UNAVAILABLE" as const });
        const response = await fetcher(
          AUTH_API_PATHS.login,
          writeOptions(csrfToken, {
            email: credentials.email.trim(),
            password: credentials.password,
          }),
        );
        if (!response.ok) {
          const code = await errorCode(response);
          return Object.freeze({
            status:
              code === "INVALID_CREDENTIALS"
                ? ("INVALID_CREDENTIALS" as const)
                : code === "RATE_LIMITED"
                  ? ("RATE_LIMITED" as const)
                  : ("UNAVAILABLE" as const),
          });
        }
        const session = parseAuthSessionResponse(await response.json());
        return session === null
          ? Object.freeze({ status: "UNAVAILABLE" as const })
          : Object.freeze({ session, status: "AUTHENTICATED" as const });
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async register(credentials) {
      if (!validCredentials(credentials)) {
        return Object.freeze({ status: "INVALID_REQUEST" as const });
      }
      try {
        const csrfToken = await getCsrf(fetcher);
        if (csrfToken === null)
          return Object.freeze({ status: "UNAVAILABLE" as const });
        const response = await fetcher(
          AUTH_API_PATHS.register,
          writeOptions(csrfToken, {
            adultAttested: true,
            email: credentials.email.trim(),
            password: credentials.password,
          }),
        );
        if (!response.ok) {
          const code = await errorCode(response);
          return Object.freeze({
            status:
              code === "REGISTRATION_NOT_AVAILABLE"
                ? ("REGISTRATION_NOT_AVAILABLE" as const)
                : code === "INVALID_REQUEST"
                  ? ("INVALID_REQUEST" as const)
                  : code === "RATE_LIMITED"
                    ? ("RATE_LIMITED" as const)
                    : ("UNAVAILABLE" as const),
          });
        }
        const session = parseAuthSessionResponse(await response.json());
        return session === null
          ? Object.freeze({ status: "UNAVAILABLE" as const })
          : Object.freeze({ session, status: "REGISTERED" as const });
      } catch {
        const reconciled = await loadSession();
        return reconciled.status === "READY"
          ? Object.freeze({
              session: reconciled.session,
              status: "REGISTERED" as const,
            })
          : Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async resendEmail(csrfToken) {
      if (!csrf(csrfToken))
        return Object.freeze({ status: "UNAVAILABLE" as const });
      try {
        const response = await fetcher(
          AUTH_API_PATHS.emailVerificationResend,
          writeOptions(csrfToken),
        );
        if (response.status === 202 && exactAccepted(await response.json())) {
          return Object.freeze({ status: "SENT" as const });
        }
        return mutationFailure(await errorCode(response));
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async sendPhone({ csrfToken, phone }) {
      const normalizedPhone = phone.trim();
      if (
        !csrf(csrfToken) ||
        normalizedPhone.length < 8 ||
        normalizedPhone.length > AUTH_INPUT_LIMITS.phoneMaximumLength
      ) {
        return Object.freeze({ status: "INVALID_REQUEST" as const });
      }
      try {
        const response = await fetcher(
          AUTH_API_PATHS.phoneVerificationSend,
          writeOptions(csrfToken, { phone: normalizedPhone }),
        );
        const body: unknown = await response.json();
        if (
          response.status === 202 &&
          exactRecord(body, ["accepted", "challengeId"]) &&
          body.accepted === true &&
          uuid(body.challengeId)
        ) {
          return Object.freeze({
            challengeId: body.challengeId,
            status: "SENT" as const,
          });
        }
        return mutationFailure(errorCodeFromBody(body));
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async verifyPhone({ challengeId, csrfToken, otp }) {
      if (!csrf(csrfToken) || !uuid(challengeId) || !/^\d{6}$/u.test(otp)) {
        return Object.freeze({ status: "INVALID_REQUEST" as const });
      }
      try {
        const response = await fetcher(
          AUTH_API_PATHS.phoneVerificationVerify,
          writeOptions(csrfToken, { challengeId, otp }),
        );
        if (response.status === 204)
          return Object.freeze({ status: "VERIFIED" as const });
        return mutationFailure(await errorCode(response));
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
  };
  return Object.freeze(client);
}

function readOptions(): RequestInit {
  return {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  };
}

function writeOptions(csrfToken: string, body?: unknown): RequestInit {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-csrf-token": csrfToken,
    },
    method: "POST",
  };
}

async function getCsrf(fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher(AUTH_API_PATHS.csrf, readOptions());
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return exactRecord(body, ["csrfToken"]) && csrf(body.csrfToken)
    ? body.csrfToken
    : null;
}

async function errorCode(response: Response): Promise<AuthErrorCode | null> {
  try {
    return errorCodeFromBody(await response.json());
  } catch {
    return null;
  }
}

function errorCodeFromBody(body: unknown): AuthErrorCode | null {
  return exactRecord(body, ["code"]) &&
    typeof body.code === "string" &&
    errorCodes.has(body.code as AuthErrorCode)
    ? (body.code as AuthErrorCode)
    : null;
}

function mutationFailure(code: AuthErrorCode | null) {
  const status =
    code === "ACCOUNT_NOT_ACTIVE"
      ? ("ACCOUNT_NOT_ACTIVE" as const)
      : code === "AUTHENTICATION_REQUIRED"
        ? ("AUTHENTICATION_REQUIRED" as const)
        : code === "INVALID_OR_EXPIRED_VERIFICATION"
          ? ("INVALID_OR_EXPIRED" as const)
          : code === "INVALID_REQUEST"
            ? ("INVALID_REQUEST" as const)
            : code === "RATE_LIMITED"
              ? ("RATE_LIMITED" as const)
              : ("UNAVAILABLE" as const);
  return Object.freeze({ status });
}

function validCredentials(input: {
  readonly email: string;
  readonly password: string;
}): boolean {
  const email = input.email.trim();
  return (
    email.length > 2 &&
    email.length <= AUTH_INPUT_LIMITS.emailMaximumLength &&
    input.password.length >= AUTH_INPUT_LIMITS.passwordMinimumLength &&
    input.password.length <= AUTH_INPUT_LIMITS.passwordMaximumLength
  );
}

function exactAccepted(value: unknown): boolean {
  return exactRecord(value, ["accepted"]) && value.accepted === true;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function csrf(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 512;
}

function isoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
