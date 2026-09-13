import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyCsrfProtection from "@fastify/csrf-protection";
import fastifyRateLimit, {
  type FastifyRateLimitStoreCtor,
} from "@fastify/rate-limit";
import fastifySession from "@fastify/session";
import {
  AUTH_API_PATHS,
  AUTH_INPUT_LIMITS,
  type AuthLoginRequest,
  type AuthPasswordResetConfirmRequest,
  type AuthPasswordResetRequest,
  type AuthRegisterRequest,
  type AuthSessionResponse,
} from "@portal/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createSessionGuard } from "./guard.js";
import { createPostgresRateLimitStoreConstructor } from "./rate-limit-store.js";
import {
  AuthInputError,
  createAuthService,
  InvalidResetTokenError,
} from "./service.js";
import { createPostgresSessionStore } from "./session-store.js";
import type {
  AuthPersistence,
  AuthRuntimeConfig,
  AuthUser,
  PasswordHasher,
  PasswordResetDeliveryPort,
  RegistrationEligibilityPort,
  ResetTokenService,
} from "./types.js";

export interface AuthModuleDependencies {
  readonly clock?: () => Date;
  readonly config: AuthRuntimeConfig;
  readonly delivery?: PasswordResetDeliveryPort;
  readonly eligibility?: RegistrationEligibilityPort;
  readonly hasher?: PasswordHasher;
  readonly persistence: AuthPersistence;
  readonly rateLimitStore?: FastifyRateLimitStoreCtor;
  readonly tokens?: ResetTokenService;
}

const denyRegistration: RegistrationEligibilityPort = Object.freeze({
  isEligible: () => Promise.resolve(false),
});
const unavailableResetDelivery: PasswordResetDeliveryPort = Object.freeze({
  deliver: () => Promise.reject(new Error("Reset delivery is unavailable")),
});

export function registerAuthModule(
  app: FastifyInstance,
  dependencies: AuthModuleDependencies,
): void {
  app.register(async (authApp) => {
    await configureAuthModule(authApp, dependencies);
  });
}

async function configureAuthModule(
  app: FastifyInstance,
  dependencies: AuthModuleDependencies,
): Promise<void> {
  const { config } = dependencies;
  const sessionStore = createPostgresSessionStore({
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    persistence: dependencies.persistence,
    cookieSecure: config.cookieSecure,
    sessionTtlMs: config.sessionTtlMs,
  });
  const rateLimitStore =
    dependencies.rateLimitStore ??
    createPostgresRateLimitStoreConstructor({
      ...(dependencies.clock === undefined
        ? {}
        : { clock: dependencies.clock }),
      persistence: dependencies.persistence,
    });

  await app.register(fastifyCors, {
    allowedHeaders: ["content-type", "x-csrf-token"],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    origin(origin, callback) {
      callback(null, origin === undefined || origin === config.appOrigin);
    },
    strictPreflight: true,
  });
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    cookie: {
      httpOnly: true,
      maxAge: config.sessionTtlMs,
      path: "/",
      sameSite: "lax",
      secure: config.cookieSecure,
    },
    cookieName: config.cookieName,
    rolling: false,
    saveUninitialized: false,
    secret: config.sessionSecret,
    store: sessionStore,
  });
  await app.register(fastifyCsrfProtection, {
    getToken: (request) => {
      const header = request.headers["x-csrf-token"];
      return typeof header === "string" ? header : undefined;
    },
    sessionPlugin: "@fastify/session",
  });
  await app.register(fastifyRateLimit, {
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error("Authentication rate limit exceeded"), {
        code: "RATE_LIMITED",
        statusCode: context.statusCode,
      }),
    global: false,
    keyGenerator: (request) => request.ip,
    max: config.rateLimitMax,
    skipOnError: false,
    store: rateLimitStore,
    timeWindow: config.rateLimitWindowMs,
  });

  const service = createAuthService({
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    delivery: dependencies.delivery ?? unavailableResetDelivery,
    eligibility: dependencies.eligibility ?? denyRegistration,
    ...(dependencies.hasher === undefined
      ? {}
      : { hasher: dependencies.hasher }),
    passwordResetTtlMs: config.passwordResetTtlMs,
    persistence: dependencies.persistence,
    ...(dependencies.tokens === undefined
      ? {}
      : { tokens: dependencies.tokens }),
  });
  const guard = createSessionGuard(dependencies.persistence);
  const rateLimit = {
    config: {
      rateLimit: {
        max: config.rateLimitMax * 5,
        timeWindow: config.rateLimitWindowMs,
      },
    },
  } as const;
  const identityRateLimit = createIdentityRateLimit({
    clock: dependencies.clock ?? (() => new Date()),
    max: config.rateLimitMax,
    persistence: dependencies.persistence,
    timeWindowMs: config.rateLimitWindowMs,
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/auth/")) {
      void reply.header("cache-control", "no-store");
    }
    done(null, payload);
  });

  app.get(AUTH_API_PATHS.csrf, async (_request, reply) => ({
    csrfToken: reply.generateCsrf(),
  }));

  app.post<{ Body: AuthRegisterRequest }>(
    AUTH_API_PATHS.register,
    {
      ...rateLimit,
      onRequest: csrfProtection(app),
      preHandler: identityRateLimit,
      schema: { body: registrationSchema },
    },
    async (request, reply) => {
      const result = await service.register(request.body);
      if (result.status === "NOT_AVAILABLE") {
        return reply.code(403).send({ code: "REGISTRATION_NOT_AVAILABLE" });
      }
      await request.session.regenerate();
      request.session.set("authUserId", result.user.id);
      return reply
        .code(201)
        .send(sessionResponse(result.user, reply.generateCsrf()));
    },
  );

  app.post<{ Body: AuthLoginRequest }>(
    AUTH_API_PATHS.login,
    {
      ...rateLimit,
      onRequest: csrfProtection(app),
      preHandler: identityRateLimit,
      schema: { body: loginSchema },
    },
    async (request, reply) => {
      const result = await service.login(request.body);
      if (result.status === "INVALID_CREDENTIALS") {
        return reply.code(401).send({ code: "INVALID_CREDENTIALS" });
      }
      await request.session.regenerate();
      request.session.set("authUserId", result.user.id);
      return reply.send(sessionResponse(result.user, reply.generateCsrf()));
    },
  );

  app.get(AUTH_API_PATHS.session, async (request, reply) => {
    const result = await guard.evaluate(request);
    if (result.status === "AUTHENTICATION_REQUIRED") {
      return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    }
    if (result.status === "ACCOUNT_NOT_ACTIVE") {
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    }
    return reply.send(sessionResponse(result.user, reply.generateCsrf()));
  });

  app.post(
    AUTH_API_PATHS.logout,
    { onRequest: csrfProtection(app) },
    async (request, reply) => {
      await request.session.destroy();
      return reply.code(204).send();
    },
  );

  app.post<{ Body: AuthPasswordResetRequest }>(
    AUTH_API_PATHS.passwordResetRequest,
    {
      ...rateLimit,
      onRequest: csrfProtection(app),
      preHandler: identityRateLimit,
      schema: { body: resetRequestSchema },
    },
    async (request, reply) => {
      if (dependencies.delivery === undefined) {
        return reply.code(503).send({ code: "INTERNAL_ERROR" });
      }
      await service.requestPasswordReset(request.body.email);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Body: AuthPasswordResetConfirmRequest }>(
    AUTH_API_PATHS.passwordReset,
    {
      ...rateLimit,
      onRequest: csrfProtection(app),
      preHandler: identityRateLimit,
      schema: { body: resetSchema },
    },
    async (request, reply) => {
      try {
        const result = await service.resetPassword(request.body);
        if (result === "INVALID") {
          return reply.code(400).send({ code: "INVALID_OR_EXPIRED_RESET" });
        }
      } catch (error: unknown) {
        if (error instanceof InvalidResetTokenError) {
          return reply.code(400).send({ code: "INVALID_OR_EXPIRED_RESET" });
        }
        throw error;
      }
      await request.session.destroy();
      return reply.code(204).send();
    },
  );

  app.setErrorHandler((error: unknown, _request, reply) => {
    const details =
      typeof error === "object" && error !== null
        ? (error as {
            readonly code?: unknown;
            readonly statusCode?: unknown;
            readonly validation?: unknown;
          })
        : {};
    if (error instanceof AuthInputError || details.validation !== undefined) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    if (details.statusCode === 429) {
      void reply.code(429).send({ code: "RATE_LIMITED" });
      return;
    }
    if (details.code === "FST_CSRF_INVALID_TOKEN") {
      void reply.code(403).send({ code: "CSRF_INVALID" });
      return;
    }
    void reply.code(500).send({ code: "INTERNAL_ERROR" });
  });
}

function sessionResponse(
  user: AuthUser,
  csrfToken: string,
): AuthSessionResponse {
  return {
    csrfToken,
    user: {
      accountState: user.accountState,
      adultAttestedAt: user.adultAttestedAt.toISOString(),
      id: user.id,
    },
  };
}

function csrfProtection(app: FastifyInstance) {
  return (
    request: Parameters<FastifyInstance["csrfProtection"]>[0],
    reply: Parameters<FastifyInstance["csrfProtection"]>[1],
    done: Parameters<FastifyInstance["csrfProtection"]>[2],
  ): void => app.csrfProtection(request, reply, done);
}

function identityRateLimitKey(request: FastifyRequest): string {
  const body = request.body;
  let identity = "invalid";
  if (typeof body === "object" && body !== null) {
    const values = body as {
      readonly email?: unknown;
      readonly token?: unknown;
    };
    if (typeof values.email === "string") {
      identity = `email:${values.email.trim().toLowerCase()}`;
    } else if (typeof values.token === "string") {
      identity = `reset:${values.token}`;
    }
  }
  return createHash("sha256")
    .update(`${request.routeOptions.url ?? "auth"}\u0000${identity}`, "utf8")
    .digest("hex");
}

function createIdentityRateLimit(input: {
  readonly clock: () => Date;
  readonly max: number;
  readonly persistence: AuthPersistence;
  readonly timeWindowMs: number;
}) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await input.persistence.consumeRateLimit({
      keyDigest: identityRateLimitKey(request),
      limit: input.max,
      now: input.clock(),
      scope: `identity:${request.routeOptions.url ?? "auth"}`,
      timeWindowMs: input.timeWindowMs,
    });
    if (result.current > input.max) {
      await reply.code(429).send({ code: "RATE_LIMITED" });
    }
  };
}

const emailProperty = {
  maxLength: AUTH_INPUT_LIMITS.emailMaximumLength,
  minLength: 3,
  type: "string",
} as const;
const passwordProperty = {
  maxLength: AUTH_INPUT_LIMITS.passwordMaximumLength,
  minLength: AUTH_INPUT_LIMITS.passwordMinimumLength,
  type: "string",
} as const;
const loginSchema = {
  additionalProperties: false,
  properties: { email: emailProperty, password: passwordProperty },
  required: ["email", "password"],
  type: "object",
} as const;
const registrationSchema = {
  ...loginSchema,
  properties: {
    ...loginSchema.properties,
    adultAttested: { const: true, type: "boolean" },
  },
  required: [...loginSchema.required, "adultAttested"],
} as const;
const resetRequestSchema = {
  additionalProperties: false,
  properties: { email: emailProperty },
  required: ["email"],
  type: "object",
} as const;
const resetSchema = {
  additionalProperties: false,
  properties: {
    newPassword: passwordProperty,
    token: {
      maxLength: AUTH_INPUT_LIMITS.resetTokenMaximumLength,
      minLength: 32,
      type: "string",
    },
  },
  required: ["newPassword", "token"],
  type: "object",
} as const;
import { createHash } from "node:crypto";
