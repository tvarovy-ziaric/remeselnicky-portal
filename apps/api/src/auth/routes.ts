import { createHash, createHmac } from "node:crypto";

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
  type AuthEmailVerificationRequest,
  type AuthLoginRequest,
  type AuthPasswordResetConfirmRequest,
  type AuthPasswordResetRequest,
  type AuthPhoneVerificationSendRequest,
  type AuthPhoneVerificationVerifyRequest,
  type AuthRegisterRequest,
  type AuthSessionResponse,
} from "@portal/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  registerAdminAuthRoutes,
  type AdminAuthRouteDependencies,
} from "../admin-auth/index.js";
import {
  registerCustomerShortlistRoutes,
  type CustomerShortlistRouteDependencies,
} from "../customer-shortlist/routes.js";
import {
  registerJobRequestDraftRoutes,
  type JobRequestDraftRouteDependencies,
} from "../job-request-drafts/routes.js";
import {
  registerJobRequestVersionRoutes,
  type JobRequestVersionRouteDependencies,
} from "../job-request-versions/routes.js";
import {
  registerJobRequestLifecycleRoutes,
  type JobRequestLifecycleRouteDependencies,
} from "../job-request-lifecycle/routes.js";
import {
  registerJobInvitationRoutes,
  type JobInvitationRouteDependencies,
} from "../job-invitations/routes.js";
import {
  registerConversationRoutes,
  type ConversationRouteDependencies,
} from "../conversations/routes.js";
import {
  registerQuoteComparisonRoutes,
  type QuoteComparisonRouteDependencies,
} from "../quote-comparison/routes.js";
import {
  registerQuoteLifecycleRoutes,
  type QuoteLifecycleRouteDependencies,
} from "../quote-lifecycle/routes.js";
import {
  registerQuoteAcceptanceRoutes,
  type QuoteAcceptanceRouteDependencies,
} from "../quote-acceptance/routes.js";
import {
  registerJobContactRoutes,
  type JobContactRouteDependencies,
} from "../job-contacts/routes.js";
import {
  registerJobDashboardRoutes,
  type JobDashboardRouteDependencies,
} from "../job-dashboard/routes.js";
import {
  registerJobLifecycleRoutes,
  type JobLifecycleRouteDependencies,
} from "../job-lifecycle/routes.js";
import {
  registerJobCompletionRoutes,
  type JobCompletionRouteDependencies,
} from "../job-completion/routes.js";
import {
  registerCompletionProposalRoutes,
  type CompletionProposalRouteDependencies,
} from "../job-completion/proposal-routes.js";
import {
  registerAdminJobCompletionRoutes,
  type AdminJobCompletionRouteDependencies,
} from "../job-completion/admin-routes.js";
import {
  registerJobDocumentationRoutes,
  type JobDocumentationRouteDependencies,
} from "../job-documentation/routes.js";
import {
  registerJobRosterRoutes,
  type JobRosterRouteDependencies,
} from "../job-roster/routes.js";
import {
  registerJobParticipationRoutes,
  type JobParticipationRouteDependencies,
} from "../job-participation/routes.js";
import {
  registerJobOperationRoutes,
  type JobOperationRouteDependencies,
} from "../job-operations/routes.js";
import {
  registerJobMilestoneRoutes,
  type JobMilestoneRouteDependencies,
} from "../job-milestones/routes.js";
import {
  registerJobMilestoneContextRoutes,
  type JobMilestoneContextRouteDependencies,
} from "../job-milestones/context-routes.js";
import {
  registerChangeOrderRoutes,
  type ChangeOrderRouteDependencies,
} from "../change-orders/routes.js";
import {
  registerJobParticipantCapabilityRoutes,
  type JobParticipantCapabilityRouteDependencies,
} from "../job-participant-capabilities/routes.js";
import {
  registerJobParticipationDetailRoute,
  type JobParticipationDetailRouteDependencies,
} from "../job-participation-detail/routes.js";
import {
  registerJobWorkGroupRoutes,
  type JobWorkGroupRouteDependencies,
} from "../job-work-groups/routes.js";
import {
  registerQuoteAuthoringRoutes,
  type QuoteAuthoringRouteDependencies,
} from "../quotes/routes.js";
import {
  registerR3AnalyticsRoutes,
  type R3AnalyticsRouteDependencies,
} from "../r3-analytics/routes.js";
import { createSessionGuard } from "./guard.js";
import {
  registerDraftHandoffRoutes,
  type DraftHandoffRouteDependencies,
} from "./draft-handoff.js";
import {
  createEmailVerificationService,
  InvalidEmailVerificationTokenError,
  type EmailVerificationDeliveryPort,
  type EmailVerificationPersistence,
  type EmailVerificationTokenService,
} from "./email-verification.js";
import { createPostgresRateLimitStoreConstructor } from "./rate-limit-store.js";
import {
  createPhoneOtpCrypto,
  createPhoneVerificationService,
  InvalidPhoneVerificationInputError,
  normalizeAndValidatePhone,
  PhoneVerificationDeliveryUnavailableError,
  type PhoneOtpCrypto,
  type PhoneVerificationDeliveryPort,
  type PhoneVerificationPersistence,
} from "./phone-verification.js";
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
  readonly adminAccess?: Pick<AdminAuthRouteDependencies, "service">;
  readonly clock?: () => Date;
  readonly config: AuthRuntimeConfig;
  readonly customerShortlist?: Pick<
    CustomerShortlistRouteDependencies,
    "onApplied" | "shortlist"
  >;
  readonly delivery?: PasswordResetDeliveryPort;
  readonly draftHandoff?: Pick<
    DraftHandoffRouteDependencies,
    "customerProfiles" | "drafts"
  >;
  readonly jobRequestDrafts?: Pick<
    JobRequestDraftRouteDependencies,
    | "customerProfiles"
    | "draftPersistence"
    | "drafts"
    | "mediaUploads"
    | "requests"
  >;
  readonly jobRequestVersions?: Pick<
    JobRequestVersionRouteDependencies,
    "versions"
  >;
  readonly jobRequestLifecycle?: Pick<
    JobRequestLifecycleRouteDependencies,
    "lifecycle"
  >;
  readonly jobInvitations?: Pick<JobInvitationRouteDependencies, "invitations">;
  readonly conversations?: Pick<ConversationRouteDependencies, "conversations">;
  readonly quoteComparison?: Pick<
    QuoteComparisonRouteDependencies,
    "comparison"
  >;
  readonly quoteLifecycle?: Pick<QuoteLifecycleRouteDependencies, "lifecycle">;
  readonly quoteAcceptance?: Pick<
    QuoteAcceptanceRouteDependencies,
    "acceptance"
  >;
  readonly jobContacts?: Pick<
    JobContactRouteDependencies,
    "clarifications" | "contacts"
  >;
  readonly jobDashboard?: Pick<JobDashboardRouteDependencies, "dashboard">;
  readonly jobLifecycle?: Pick<JobLifecycleRouteDependencies, "lifecycle">;
  readonly jobCompletion?: Pick<JobCompletionRouteDependencies, "completion">;
  readonly completionProposals?: Pick<
    CompletionProposalRouteDependencies,
    "proposals"
  >;
  readonly adminJobCompletion?: Pick<
    AdminJobCompletionRouteDependencies,
    "completion"
  >;
  readonly jobDocumentation?: Pick<
    JobDocumentationRouteDependencies,
    "documentation"
  >;
  readonly jobRoster?: Pick<JobRosterRouteDependencies, "roster">;
  readonly jobParticipation?: Pick<
    JobParticipationRouteDependencies,
    "participation"
  >;
  readonly jobOperations?: Pick<JobOperationRouteDependencies, "operations">;
  readonly jobMilestones?: Pick<JobMilestoneRouteDependencies, "milestones">;
  readonly jobMilestoneContext?: Pick<
    JobMilestoneContextRouteDependencies,
    "context"
  >;
  readonly changeOrders?: Pick<
    ChangeOrderRouteDependencies,
    "changeOrders" | "pdfReservations" | "documentUploads"
  >;
  readonly jobParticipantCapabilities?: Pick<
    JobParticipantCapabilityRouteDependencies,
    "capabilities"
  >;
  readonly jobParticipationDetail?: Pick<
    JobParticipationDetailRouteDependencies,
    "detail"
  >;
  readonly jobWorkGroups?: Pick<JobWorkGroupRouteDependencies, "workGroups">;
  readonly quoteAuthoring?: Pick<
    QuoteAuthoringRouteDependencies,
    | "core"
    | "documentUploads"
    | "externalPdf"
    | "structured"
    | "supportingDocumentUploads"
    | "supportingDocuments"
  >;
  readonly r3Analytics?: Pick<R3AnalyticsRouteDependencies, "observations">;
  readonly conversationChat?: {
    readonly admission: Exclude<
      NonNullable<ConversationRouteDependencies["chat"]>["admission"],
      undefined
    >;
    readonly attachmentUploads?: NonNullable<
      ConversationRouteDependencies["chat"]
    >["attachmentUploads"];
    readonly persistence: NonNullable<
      ConversationRouteDependencies["chat"]
    >["persistence"];
    readonly pdfDeliveryObservation?: NonNullable<
      ConversationRouteDependencies["chat"]
    >["pdfDeliveryObservation"];
    readonly privateMediaDelivery?: NonNullable<
      ConversationRouteDependencies["chat"]
    >["privateMediaDelivery"];
    readonly service: NonNullable<
      ConversationRouteDependencies["chat"]
    >["service"];
  };
  readonly emailVerification?: {
    readonly delivery?: EmailVerificationDeliveryPort;
    readonly persistence: EmailVerificationPersistence;
    readonly resendLimit?: number;
    readonly resendWindowMs?: number;
    readonly tokenTtlMs?: number;
    readonly tokens?: EmailVerificationTokenService;
  };
  readonly eligibility?: RegistrationEligibilityPort;
  readonly hasher?: PasswordHasher;
  readonly persistence: AuthPersistence;
  readonly phoneVerification?: {
    readonly crypto?: PhoneOtpCrypto;
    readonly delivery?: PhoneVerificationDeliveryPort;
    readonly persistence: PhoneVerificationPersistence;
  };
  readonly rateLimitStore?: FastifyRateLimitStoreCtor;
  readonly tokens?: ResetTokenService;
}

const emailVerificationDefaults = Object.freeze({
  resendLimit: 3,
  resendWindowMs: 15 * 60 * 1_000,
  tokenTtlMs: 24 * 60 * 60 * 1_000,
});
const phoneVerificationDefaults = Object.freeze({
  maxAttempts: 5,
  resendLimit: 3,
  ttlMs: 10 * 60 * 1_000,
  verifyLimit: 10,
  windowMs: 15 * 60 * 1_000,
});

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
  if (dependencies.draftHandoff !== undefined) {
    registerDraftHandoffRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: rateLimit.config.rateLimit.max,
        timeWindowMs: rateLimit.config.rateLimit.timeWindow,
      },
      ...dependencies.draftHandoff,
    });
  }
  if (dependencies.jobRequestDrafts !== undefined) {
    registerJobRequestDraftRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      ...dependencies.jobRequestDrafts,
    });
  }
  if (dependencies.jobRequestVersions !== undefined) {
    registerJobRequestVersionRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      ...dependencies.jobRequestVersions,
    });
  }
  if (dependencies.jobRequestLifecycle !== undefined) {
    registerJobRequestLifecycleRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      ...dependencies.jobRequestLifecycle,
    });
  }
  if (dependencies.jobInvitations !== undefined) {
    registerJobInvitationRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: rateLimit.config.rateLimit.max,
        timeWindowMs: rateLimit.config.rateLimit.timeWindow,
      },
      ...dependencies.jobInvitations,
    });
  }
  if (dependencies.conversations !== undefined) {
    registerConversationRoutes(app, {
      guard,
      ...(dependencies.conversationChat === undefined
        ? {}
        : {
            chat: {
              admission: dependencies.conversationChat.admission,
              ...(dependencies.conversationChat.attachmentUploads === undefined
                ? {}
                : {
                    attachmentUploads:
                      dependencies.conversationChat.attachmentUploads,
                  }),
              csrfProtection: csrfProtection(app),
              persistence: dependencies.conversationChat.persistence,
              ...(dependencies.conversationChat.pdfDeliveryObservation ===
              undefined
                ? {}
                : {
                    pdfDeliveryObservation:
                      dependencies.conversationChat.pdfDeliveryObservation,
                  }),
              ...(dependencies.conversationChat.privateMediaDelivery ===
              undefined
                ? {}
                : {
                    privateMediaDelivery:
                      dependencies.conversationChat.privateMediaDelivery,
                  }),
              service: dependencies.conversationChat.service,
            },
          }),
      ...dependencies.conversations,
    });
  }
  if (dependencies.quoteComparison !== undefined) {
    registerQuoteComparisonRoutes(app, {
      guard,
      ...dependencies.quoteComparison,
    });
  }
  if (dependencies.quoteLifecycle !== undefined) {
    registerQuoteLifecycleRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      ...dependencies.quoteLifecycle,
    });
  }
  if (dependencies.quoteAcceptance !== undefined) {
    registerQuoteAcceptanceRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.quoteAcceptance,
    });
  }
  if (dependencies.jobContacts !== undefined) {
    registerJobContactRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobContacts,
    });
  }
  if (dependencies.jobDashboard !== undefined) {
    registerJobDashboardRoutes(app, {
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobDashboard,
    });
  }
  if (dependencies.jobLifecycle !== undefined) {
    registerJobLifecycleRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobLifecycle,
    });
  }
  if (dependencies.jobCompletion !== undefined) {
    registerJobCompletionRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobCompletion,
    });
  }
  if (dependencies.completionProposals !== undefined) {
    registerCompletionProposalRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.completionProposals,
    });
  }
  if (dependencies.jobDocumentation !== undefined) {
    registerJobDocumentationRoutes(app, {
      guard,
      rateLimit: {
        max: config.rateLimitMax * 6,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobDocumentation,
    });
  }
  if (dependencies.jobRoster !== undefined) {
    registerJobRosterRoutes(app, {
      guard,
      rateLimit: {
        max: config.rateLimitMax * 6,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobRoster,
    });
  }
  if (dependencies.jobParticipation !== undefined) {
    registerJobParticipationRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobParticipation,
    });
  }
  if (dependencies.jobOperations !== undefined) {
    registerJobOperationRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobOperations,
    });
  }
  if (dependencies.jobMilestones !== undefined) {
    registerJobMilestoneRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobMilestones,
    });
  }
  if (dependencies.jobMilestoneContext !== undefined) {
    registerJobMilestoneContextRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobMilestoneContext,
    });
  }
  if (dependencies.changeOrders !== undefined) {
    registerChangeOrderRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.changeOrders,
    });
  }
  if (dependencies.jobParticipantCapabilities !== undefined) {
    registerJobParticipantCapabilityRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobParticipantCapabilities,
    });
  }
  if (dependencies.jobParticipationDetail !== undefined) {
    registerJobParticipationDetailRoute(app, {
      guard,
      rateLimit: {
        max: config.rateLimitMax * 6,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobParticipationDetail,
    });
  }
  if (dependencies.jobWorkGroups !== undefined) {
    registerJobWorkGroupRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.jobWorkGroups,
    });
  }
  if (dependencies.quoteAuthoring !== undefined) {
    registerQuoteAuthoringRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: rateLimit.config.rateLimit.max,
        timeWindowMs: rateLimit.config.rateLimit.timeWindow,
      },
      ...dependencies.quoteAuthoring,
    });
  }
  if (dependencies.r3Analytics !== undefined) {
    registerR3AnalyticsRoutes(app, {
      csrfProtection: csrfProtection(app),
      guard,
      rateLimit: {
        max: config.rateLimitMax,
        timeWindowMs: config.rateLimitWindowMs,
      },
      ...dependencies.r3Analytics,
    });
  }
  if (dependencies.customerShortlist !== undefined) {
    registerCustomerShortlistRoutes(app, {
      guard,
      ...dependencies.customerShortlist,
    });
  }
  if (dependencies.adminAccess !== undefined) {
    registerAdminAuthRoutes(app, {
      config,
      guard,
      persistence: dependencies.persistence,
      service: dependencies.adminAccess.service,
    });
    if (dependencies.adminJobCompletion !== undefined) {
      registerAdminJobCompletionRoutes(app, {
        adminAccess: dependencies.adminAccess.service,
        completion: dependencies.adminJobCompletion.completion,
        guard,
        csrfProtection: csrfProtection(app),
        rateLimit: {
          max: config.rateLimitMax,
          timeWindowMs: config.rateLimitWindowMs,
        },
      });
    }
  }
  const emailVerification =
    dependencies.emailVerification === undefined
      ? undefined
      : createEmailVerificationService({
          ...(dependencies.clock === undefined
            ? {}
            : { clock: dependencies.clock }),
          delivery:
            dependencies.emailVerification.delivery ??
            unavailableEmailVerificationDelivery,
          persistence: dependencies.emailVerification.persistence,
          tokenTtlMs:
            dependencies.emailVerification.tokenTtlMs ??
            emailVerificationDefaults.tokenTtlMs,
          ...(dependencies.emailVerification.tokens === undefined
            ? {}
            : { tokens: dependencies.emailVerification.tokens }),
        });
  const phoneVerification =
    dependencies.phoneVerification === undefined
      ? undefined
      : createPhoneVerificationService({
          ...(dependencies.clock === undefined
            ? {}
            : { clock: dependencies.clock }),
          crypto:
            dependencies.phoneVerification.crypto ??
            createPhoneOtpCrypto({ pepper: config.sessionSecret }),
          delivery:
            dependencies.phoneVerification.delivery ??
            unavailablePhoneVerificationDelivery,
          maxAttempts:
            config.phoneOtpMaxAttempts ?? phoneVerificationDefaults.maxAttempts,
          persistence: dependencies.phoneVerification.persistence,
          ttlMs: config.phoneOtpTtlMs ?? phoneVerificationDefaults.ttlMs,
        });
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
      await request.session.regenerate([
        "pendingDraftHandoffId",
        "completedDraftHandoffId",
      ]);
      request.session.set("authUserId", result.user.id);
      if (
        emailVerification !== undefined &&
        dependencies.emailVerification?.delivery !== undefined
      ) {
        await emailVerification.request(result.user.id);
      }
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
      await request.session.regenerate([
        "pendingDraftHandoffId",
        "completedDraftHandoffId",
      ]);
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

  if (emailVerification !== undefined) {
    app.post<{ Body: AuthEmailVerificationRequest }>(
      AUTH_API_PATHS.emailVerification,
      {
        ...rateLimit,
        onRequest: csrfProtection(app),
        preHandler: identityRateLimit,
        schema: { body: emailVerificationSchema },
      },
      async (request, reply) => {
        try {
          const result = await emailVerification.confirm(request.body.token);
          if (result === "INVALID") {
            return reply
              .code(400)
              .send({ code: "INVALID_OR_EXPIRED_VERIFICATION" });
          }
        } catch (error: unknown) {
          if (error instanceof InvalidEmailVerificationTokenError) {
            return reply
              .code(400)
              .send({ code: "INVALID_OR_EXPIRED_VERIFICATION" });
          }
          throw error;
        }
        return reply.code(204).send();
      },
    );

    app.post(
      AUTH_API_PATHS.emailVerificationResend,
      {
        ...rateLimit,
        onRequest: csrfProtection(app),
      },
      async (request, reply) => {
        const actor = await guard.evaluate(request);
        if (actor.status === "AUTHENTICATION_REQUIRED") {
          return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
        }
        if (actor.status === "ACCOUNT_NOT_ACTIVE") {
          return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
        }
        if (dependencies.emailVerification?.delivery === undefined) {
          return reply.code(503).send({ code: "INTERNAL_ERROR" });
        }

        const resendLimit =
          dependencies.emailVerification.resendLimit ??
          emailVerificationDefaults.resendLimit;
        const resendWindowMs =
          dependencies.emailVerification.resendWindowMs ??
          emailVerificationDefaults.resendWindowMs;
        const now = dependencies.clock?.() ?? new Date();
        const consumed = await dependencies.persistence.consumeRateLimit({
          keyDigest: createHash("sha256")
            .update(`email-verification-resend\u0000${actor.user.id}`, "utf8")
            .digest("hex"),
          limit: resendLimit,
          now,
          scope: "email-verification-resend:user",
          timeWindowMs: resendWindowMs,
        });
        if (consumed.current > resendLimit) {
          return reply.code(429).send({ code: "RATE_LIMITED" });
        }

        await emailVerification.request(actor.user.id);
        return reply.code(202).send({ accepted: true });
      },
    );
  }

  if (phoneVerification !== undefined) {
    app.post<{ Body: AuthPhoneVerificationSendRequest }>(
      AUTH_API_PATHS.phoneVerificationSend,
      {
        ...rateLimit,
        onRequest: csrfProtection(app),
        schema: { body: phoneVerificationSendSchema },
      },
      async (request, reply) => {
        const actor = await guard.evaluate(request);
        if (actor.status === "AUTHENTICATION_REQUIRED") {
          return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
        }
        if (actor.status === "ACCOUNT_NOT_ACTIVE") {
          return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
        }
        if (dependencies.phoneVerification?.delivery === undefined) {
          return reply.code(503).send({ code: "INTERNAL_ERROR" });
        }

        let normalizedPhone: string;
        try {
          normalizedPhone = normalizeAndValidatePhone(request.body.phone);
        } catch (error: unknown) {
          if (error instanceof InvalidPhoneVerificationInputError) {
            return reply.code(400).send({ code: "INVALID_REQUEST" });
          }
          throw error;
        }
        const limited = await consumePhoneVerificationRateLimits({
          clock: dependencies.clock ?? (() => new Date()),
          config,
          ip: request.ip,
          persistence: dependencies.persistence,
          phone: normalizedPhone,
          purpose: "send",
          userId: actor.user.id,
        });
        if (limited) {
          return reply.code(429).send({ code: "RATE_LIMITED" });
        }

        try {
          const result = await phoneVerification.request({
            normalizedPhone,
            userId: actor.user.id,
          });
          return reply.code(202).send(result);
        } catch (error: unknown) {
          if (error instanceof InvalidPhoneVerificationInputError) {
            return reply.code(400).send({ code: "INVALID_REQUEST" });
          }
          if (error instanceof PhoneVerificationDeliveryUnavailableError) {
            return reply.code(503).send({ code: "INTERNAL_ERROR" });
          }
          throw error;
        }
      },
    );

    app.post<{ Body: AuthPhoneVerificationVerifyRequest }>(
      AUTH_API_PATHS.phoneVerificationVerify,
      {
        ...rateLimit,
        onRequest: csrfProtection(app),
        schema: { body: phoneVerificationVerifySchema },
      },
      async (request, reply) => {
        const actor = await guard.evaluate(request);
        if (actor.status === "AUTHENTICATION_REQUIRED") {
          return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
        }
        if (actor.status === "ACCOUNT_NOT_ACTIVE") {
          return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
        }

        const limited = await consumePhoneVerificationRateLimits({
          clock: dependencies.clock ?? (() => new Date()),
          config,
          ip: request.ip,
          persistence: dependencies.persistence,
          purpose: "verify",
          userId: actor.user.id,
        });
        if (limited) {
          return reply.code(429).send({ code: "RATE_LIMITED" });
        }

        try {
          const result = await phoneVerification.verify({
            challengeId: request.body.challengeId,
            otp: request.body.otp,
            userId: actor.user.id,
          });
          if (result === "INVALID") {
            return reply
              .code(400)
              .send({ code: "INVALID_OR_EXPIRED_VERIFICATION" });
          }
          return reply.code(204).send();
        } catch (error: unknown) {
          if (error instanceof InvalidPhoneVerificationInputError) {
            return reply
              .code(400)
              .send({ code: "INVALID_OR_EXPIRED_VERIFICATION" });
          }
          throw error;
        }
      },
    );
  }

  app.setErrorHandler((error: unknown, _request, reply) => {
    const details =
      typeof error === "object" && error !== null
        ? (error as {
            readonly code?: unknown;
            readonly statusCode?: unknown;
            readonly validation?: unknown;
          })
        : {};
    if (
      error instanceof AuthInputError ||
      error instanceof InvalidPhoneVerificationInputError ||
      details.validation !== undefined
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    if (details.statusCode === 429) {
      void reply.code(429).send({ code: "RATE_LIMITED" });
      return;
    }
    if (
      details.code === "FST_CSRF_INVALID_TOKEN" ||
      details.code === "FST_CSRF_MISSING_SECRET"
    ) {
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
      emailVerified: user.emailVerifiedAt !== null,
      id: user.id,
      phoneVerified: user.phoneVerifiedAt !== null,
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
const emailVerificationSchema = {
  additionalProperties: false,
  properties: {
    token: {
      maxLength: AUTH_INPUT_LIMITS.verificationTokenMaximumLength,
      minLength: 32,
      type: "string",
    },
  },
  required: ["token"],
  type: "object",
} as const;
const phoneVerificationSendSchema = {
  additionalProperties: false,
  properties: {
    phone: {
      maxLength: AUTH_INPUT_LIMITS.phoneMaximumLength,
      minLength: 8,
      type: "string",
    },
  },
  required: ["phone"],
  type: "object",
} as const;
const phoneVerificationVerifySchema = {
  additionalProperties: false,
  properties: {
    challengeId: {
      maxLength: 36,
      minLength: 36,
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
      type: "string",
    },
    otp: {
      maxLength: AUTH_INPUT_LIMITS.phoneOtpLength,
      minLength: AUTH_INPUT_LIMITS.phoneOtpLength,
      pattern: "^[0-9]{6}$",
      type: "string",
    },
  },
  required: ["challengeId", "otp"],
  type: "object",
} as const;
const unavailableEmailVerificationDelivery: EmailVerificationDeliveryPort =
  Object.freeze({
    deliver: () =>
      Promise.reject(new Error("Email-verification delivery is unavailable")),
  });
const unavailablePhoneVerificationDelivery: PhoneVerificationDeliveryPort =
  Object.freeze({
    deliver: () =>
      Promise.reject(new Error("Phone-verification delivery is unavailable")),
  });

async function consumePhoneVerificationRateLimits(input: {
  readonly clock: () => Date;
  readonly config: AuthRuntimeConfig;
  readonly ip: string;
  readonly persistence: AuthPersistence;
  readonly phone?: string;
  readonly purpose: "send" | "verify";
  readonly userId: string;
}): Promise<boolean> {
  const now = input.clock();
  const windowMs =
    input.config.phoneOtpWindowMs ?? phoneVerificationDefaults.windowMs;
  const baseLimit =
    input.purpose === "send"
      ? (input.config.phoneOtpResendLimit ??
        phoneVerificationDefaults.resendLimit)
      : (input.config.phoneOtpVerifyLimit ??
        phoneVerificationDefaults.verifyLimit);
  const identities = [
    { limit: baseLimit, name: "user", value: input.userId },
    { limit: baseLimit * 4, name: "ip", value: input.ip },
    ...(input.phone === undefined
      ? []
      : [{ limit: baseLimit, name: "phone", value: input.phone }]),
  ] as const;

  let limited = false;
  for (const identity of identities) {
    const consumed = await input.persistence.consumeRateLimit({
      keyDigest: createHmac("sha256", input.config.sessionSecret)
        .update(
          `portal-phone-rate-v1\0${input.purpose}\0${identity.name}\0${identity.value}`,
          "utf8",
        )
        .digest("hex"),
      limit: identity.limit,
      now,
      scope: `phone-otp-${input.purpose}:${identity.name}`,
      timeWindowMs: windowMs,
    });
    limited ||= consumed.current > identity.limit;
  }
  return limited;
}
