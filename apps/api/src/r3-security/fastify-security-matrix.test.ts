import { randomUUID } from "node:crypto";

import { AUTH_API_PATHS } from "@portal/contracts";
import type {
  Conversation,
  ConversationChatPersistence,
  ConversationChatService,
  ConversationId,
  ConversationPersistence,
  ExternalPdfQuotePersistence,
  ExternalPdfQuoteRevision,
  JobInvitationDetail,
  JobInvitationId,
  JobInvitationPersistence,
  JobRequestId,
  Quote,
  QuoteComparisonPersistence,
  QuoteId,
  QuoteLifecyclePersistence,
  QuotePersistence,
  StructuredQuoteContentRevision,
  StructuredQuotePersistence,
  UserAccountState,
  UserId,
} from "@portal/domain";
import {
  R3_HTTP_SECURITY_CASES,
  verifyR3HttpSecurityMatrix,
  type R3HttpBoundaryResult,
  type R3HttpCorsEvidence,
  type R3HttpSecurityCase,
  type R3HttpSecurityMatrixAdapter,
  type R3SecurityActor,
  type R3SecurityState,
  type R3SecurityTarget,
} from "@portal/testing";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "../app.js";
import type {
  AuthPersistence,
  AuthUser,
  StoredSession,
} from "../auth/types.js";
import { CONVERSATION_PATHS } from "../conversations/routes.js";
import { JOB_INVITATION_PATHS } from "../job-invitations/routes.js";
import { QUOTE_COMPARISON_PATH } from "../quote-comparison/routes.js";
import { QUOTE_LIFECYCLE_PATHS } from "../quote-lifecycle/routes.js";
import { QUOTE_AUTHORING_PATHS } from "../quotes/routes.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const appOrigin = "https://portal.example.test";
const cookieName = "portal.sid";
const privateMarker = "R3_HTTP_PRIVATE_CANARY_022";
const openApps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("R3 Fastify/session/CSRF security adapter", () => {
  it("verifies the existing R3 transport matrix without claiming DB authorization", async () => {
    const fixture = await createFixture();
    const report = await verifyR3HttpSecurityMatrix(fixture.adapter);

    expect(report).toMatchObject({
      anonymousProbes: 8,
      commandCsrfChecks: 200,
      databaseAuthorization: "PROVEN_SEPARATELY_BY_STAGE_ONE_LIVE_PG",
      probes: R3_HTTP_SECURITY_CASES.length,
      status: "FASTIFY_TRANSPORT_VERIFIED",
    });
    expect(report.missingProductionSeams).toEqual([
      "PRIVATE_MEDIA_PRODUCTION_COMPOSITION",
      "JOB_REQUEST_PRIVATE_MEDIA_DELIVERY",
      "BROWSER_STAGING_E2E",
    ]);
  }, 15_000);

  it("covers Quote core and both authoring-mode transports with exact actor, state and CSRF boundaries", async () => {
    const fixture = await createFixture();
    const target = fixture.targets.EXACT_OWN;
    const provider = requiredSession(fixture, "PROVIDER_OWNER");
    const customer = requiredSession(fixture, "CUSTOMER_OWNER");
    const competitor = requiredSession(fixture, "COMPETING_PROVIDER");
    const suspended = requiredSession(fixture, "SUSPENDED_PROVIDER_OWNER");
    const quotePath = authoringPath(QUOTE_AUTHORING_PATHS.quote, target);
    const structuredPath = authoringPath(
      QUOTE_AUTHORING_PATHS.structured,
      target,
    );
    const externalPath = authoringPath(QUOTE_AUTHORING_PATHS.external, target);

    await expectStatus(fixture, provider, "GET", quotePath, 200);
    await expectStatus(
      fixture,
      provider,
      "GET",
      authoringPath(QUOTE_AUTHORING_PATHS.byInvitation, target),
      200,
    );
    await expectStatus(fixture, provider, "GET", structuredPath, 200);
    await expectStatus(fixture, provider, "GET", externalPath, 200);
    await expectStatus(fixture, competitor, "GET", quotePath, 404, "NOT_FOUND");
    await expectStatus(
      fixture,
      suspended,
      "GET",
      quotePath,
      403,
      "ACCOUNT_NOT_ACTIVE",
    );

    const createBody = {
      authoringMode: "PLATFORM_STRUCTURED",
      commandId: randomUUID(),
      requestContentRevision: 2,
      requestVisibleVersion: 1,
    };
    const createPath = authoringPath(QUOTE_AUTHORING_PATHS.create, target);
    const before = fixture.ports.quoteEffects;
    await expectStatus(
      fixture,
      { cookie: provider.cookie },
      "POST",
      createPath,
      403,
      "CSRF_INVALID",
      createBody,
    );
    await expectStatus(
      fixture,
      { ...provider, csrfToken: "wrong-token" },
      "POST",
      createPath,
      403,
      "CSRF_INVALID",
      createBody,
    );
    expect(fixture.ports.quoteEffects).toBe(before);
    await expectStatus(fixture, provider, "POST", createPath, 201, undefined, {
      ...createBody,
      commandId: randomUUID(),
    });
    expect(fixture.ports.quoteEffects).toBe(before + 1);
    await expectStatus(
      fixture,
      customer,
      "POST",
      createPath,
      404,
      "NOT_FOUND",
      { ...createBody, commandId: randomUUID() },
    );

    await expectStatus(
      fixture,
      provider,
      "POST",
      structuredPath,
      200,
      undefined,
      structuredSaveBody(),
    );
    await expectStatus(
      fixture,
      competitor,
      "POST",
      structuredPath,
      404,
      "NOT_FOUND",
      structuredSaveBody(),
    );
    await expectStatus(
      fixture,
      provider,
      "POST",
      externalPath,
      200,
      undefined,
      externalSaveBody(),
    );

    await expectStatus(
      fixture,
      provider,
      "POST",
      authoringPath(QUOTE_AUTHORING_PATHS.submit, target),
      200,
      undefined,
      {
        commandId: randomUUID(),
        expectedDraftStateRevision: 1,
        expectedSubmittedStateRevision: null,
      },
    );
    fixture.ports.state = "TERMINAL_LINEAGE";
    await expectStatus(
      fixture,
      provider,
      "POST",
      createPath,
      409,
      "READ_ONLY",
      { ...createBody, commandId: randomUUID() },
    );
  });

  it("covers existing Quote lifecycle transport without inventing authoring endpoints", async () => {
    const fixture = await createFixture();
    const exactQuoteId = fixture.targets.EXACT_OWN.quoteId;
    const provider = fixture.sessions.PROVIDER_OWNER;
    const customer = fixture.sessions.CUSTOMER_OWNER;
    const competitor = fixture.sessions.COMPETING_PROVIDER;
    const suspended = fixture.sessions.SUSPENDED_PROVIDER_OWNER;
    if (
      provider === undefined ||
      customer === undefined ||
      competitor === undefined ||
      suspended === undefined
    ) {
      throw new Error("Missing R3 HTTP lifecycle sessions.");
    }

    await expectStatus(
      fixture,
      customer,
      "GET",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.context, exactQuoteId),
      200,
    );
    await expectStatus(
      fixture,
      competitor,
      "GET",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.context, exactQuoteId),
      404,
      "NOT_FOUND",
    );
    await expectStatus(
      fixture,
      suspended,
      "GET",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.context, exactQuoteId),
      403,
      "ACCOUNT_NOT_ACTIVE",
    );

    const withdrawBody = {
      commandId: randomUUID(),
      expectedStateRevision: 2,
      quoteRevision: 1,
    };
    const before = fixture.ports.lifecycleEffects;
    await expectStatus(
      fixture,
      { cookie: provider.cookie },
      "POST",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.withdraw, exactQuoteId),
      403,
      "CSRF_INVALID",
      withdrawBody,
    );
    expect(fixture.ports.lifecycleEffects).toBe(before);
    await expectStatus(
      fixture,
      { ...provider, csrfToken: "wrong-token" },
      "POST",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.withdraw, exactQuoteId),
      403,
      "CSRF_INVALID",
      withdrawBody,
    );
    expect(fixture.ports.lifecycleEffects).toBe(before);
    await expectStatus(
      fixture,
      provider,
      "POST",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.withdraw, exactQuoteId),
      200,
      undefined,
      withdrawBody,
    );
    expect(fixture.ports.lifecycleEffects).toBe(before + 1);
    await expectStatus(
      fixture,
      customer,
      "POST",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.withdraw, exactQuoteId),
      404,
      "NOT_FOUND",
      { ...withdrawBody, commandId: randomUUID() },
    );
    expect(fixture.ports.lifecycleEffects).toBe(before + 1);

    await expectStatus(
      fixture,
      provider,
      "POST",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.reconfirm, exactQuoteId),
      201,
      undefined,
      {
        authoringMode: "PLATFORM_STRUCTURED",
        commandId: randomUUID(),
        expectedSourceStateRevision: 3,
        sourceQuoteRevision: 1,
        sourceState: "WITHDRAWN",
      },
    );
    await expectStatus(
      fixture,
      customer,
      "POST",
      lifecyclePath(QUOTE_LIFECYCLE_PATHS.reconfirm, exactQuoteId),
      404,
      "NOT_FOUND",
      {
        authoringMode: "PLATFORM_STRUCTURED",
        commandId: randomUUID(),
        expectedSourceStateRevision: 3,
        sourceQuoteRevision: 1,
        sourceState: "WITHDRAWN",
      },
    );
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: `/v1/me/quotes/${exactQuoteId}/expire`,
        })
      ).statusCode,
    ).toBe(404);
  });
});

interface SessionHandle {
  readonly cookie: string;
  readonly csrfToken?: string;
}

interface HttpRequestSpec {
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "GET" | "POST";
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly url: string;
}

interface TargetIds {
  readonly conversationId: ConversationId;
  readonly invitationId: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly quoteId: QuoteId;
}

interface Fixture {
  readonly adapter: R3HttpSecurityMatrixAdapter;
  readonly anonymousSession: SessionHandle;
  readonly app: ReturnType<typeof buildApi>;
  readonly ports: BoundaryPorts;
  readonly sessions: Readonly<Partial<Record<R3SecurityActor, SessionHandle>>>;
  readonly targets: Readonly<Record<R3SecurityTarget, TargetIds>>;
}

class TestAuthPersistence implements AuthPersistence {
  private lastWrittenSessionId: string | undefined;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly users = new Map<UserId, AuthUser>();

  public addUser(id: UserId, accountState: UserAccountState): void {
    this.users.set(id, {
      activeModerationScopes: [],
      accountState,
      adultAttestedAt: now,
      emailVerifiedAt: now,
      id,
      phoneVerifiedAt: now,
    });
  }

  public bindLastSession(userId: UserId): void {
    const id = this.lastWrittenSessionId;
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (id === undefined || session === undefined) {
      throw new Error("Missing generated R3 HTTP session.");
    }
    this.sessions.set(id, {
      ...session,
      payload: { ...session.payload, authUserId: userId },
      userId,
    });
  }

  public consumePasswordReset(): Promise<"INVALID"> {
    return Promise.resolve("INVALID");
  }

  public consumeRateLimit(input: {
    readonly timeWindowMs: number;
  }): Promise<{ current: number; ttlMs: number }> {
    return Promise.resolve({ current: 1, ttlMs: input.timeWindowMs });
  }

  public createPasswordReset(): Promise<void> {
    return Promise.resolve();
  }

  public destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  public findCredentialByEmail(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public findUserById(userId: UserId): Promise<AuthUser | undefined> {
    return Promise.resolve(this.users.get(userId));
  }

  public readSession(
    sessionId: string,
    at: Date,
  ): Promise<StoredSession | undefined> {
    const session = this.sessions.get(sessionId);
    return Promise.resolve(
      session !== undefined && session.expiresAt > at ? session : undefined,
    );
  }

  public register(): Promise<{ readonly status: "DUPLICATE" }> {
    return Promise.resolve({ status: "DUPLICATE" });
  }

  public revokeAllSessions(userId: UserId): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(id);
    }
    return Promise.resolve();
  }

  public writeSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, session);
    this.lastWrittenSessionId = session.id;
    return Promise.resolve();
  }
}

class BoundaryPorts {
  public messageEffects = 0;
  public lifecycleEffects = 0;
  public quoteEffects = 0;
  public state: R3SecurityState = "WRITABLE";

  public constructor(
    private readonly actorById: ReadonlyMap<UserId, R3SecurityActor>,
    private readonly targets: Readonly<Record<R3SecurityTarget, TargetIds>>,
  ) {}

  public readonly conversations: Pick<
    ConversationPersistence,
    "readOwned" | "readOwnedByInvitation"
  > = {
    readOwned: (input: {
      readonly actorUserId: UserId;
      readonly conversationId: ConversationId;
    }) => this.readConversation(input.actorUserId, input.conversationId),
    readOwnedByInvitation: (input: {
      readonly actorUserId: UserId;
      readonly invitationId: JobInvitationId;
    }) => {
      const target = this.targetFor("invitationId", input.invitationId);
      return Promise.resolve(
        this.canReadBilateral(input.actorUserId, target)
          ? conversation(
              this.targets[target],
              input.actorUserId,
              target,
              this.state,
            )
          : null,
      );
    },
  };

  public readonly chat: ConversationChatPersistence & ConversationChatService =
    {
      readTimeline: (input) => {
        const target = this.targetFor("conversationId", input.conversationId);
        return Promise.resolve(
          this.canReadBilateral(input.actorUserId, target)
            ? timeline(this.targets[target], this.state)
            : null,
        );
      },
      report: () => Promise.resolve({ status: "NOT_FOUND" }),
      sendMessage: (input) => {
        const target = this.targetFor("conversationId", input.conversationId);
        if (!this.canReadBilateral(input.actorUserId, target)) {
          return Promise.resolve({ status: "NOT_FOUND" as const });
        }
        if (this.state === "TERMINAL_LINEAGE") {
          return Promise.resolve({ status: "READ_ONLY" as const });
        }
        this.messageEffects += 1;
        return Promise.resolve({
          entry: messageEntry(this.targets[target]),
          status: "SENT" as const,
        });
      },
      updateParticipantState: () => Promise.resolve({ status: "NOT_FOUND" }),
    };

  public readonly invitations: Pick<
    JobInvitationPersistence,
    "closeOwned" | "listOwned" | "readOwned" | "respondOwned" | "sendOwned"
  > = {
    closeOwned: () => Promise.resolve({ status: "NOT_FOUND" }),
    listOwned: () => Promise.resolve([]),
    readOwned: (input) => {
      const target = this.targetFor("invitationId", input.invitationId);
      return Promise.resolve(
        this.canReadBilateral(input.actorUserId, target)
          ? invitation(this.targets[target], input.actorUserId, target)
          : null,
      );
    },
    respondOwned: () => Promise.resolve({ status: "NOT_FOUND" }),
    sendOwned: () => Promise.resolve({ status: "NOT_FOUND" }),
  };

  public readonly comparison: QuoteComparisonPersistence = {
    readCurrent: (input) => {
      const target = this.targetFor("jobRequestId", input.jobRequestId);
      return Promise.resolve(
        this.role(input.actorUserId, target) === "CUSTOMER"
          ? {
              items: [],
              jobRequestId: input.jobRequestId,
              sort: input.sort ?? "RECEIVED",
            }
          : null,
      );
    },
  };

  public readonly quotes: QuotePersistence = {
    createDraft: (input) =>
      this.providerCommand(
        input.actorUserId,
        this.targetFor("conversationId", input.conversationId),
      ),
    createRevision: (input) =>
      this.providerCommand(
        input.actorUserId,
        this.targetFor("quoteId", input.quoteId),
      ),
    readOwned: (input) => this.readQuote(input.actorUserId, input.quoteId),
    readOwnedByInvitation: (input) => {
      const target = this.targetFor("invitationId", input.invitationId);
      return Promise.resolve(
        this.canReadBilateral(input.actorUserId, target)
          ? quote(this.targets[target], this.role(input.actorUserId, target))
          : null,
      );
    },
    reject: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      if (this.role(input.actorUserId, target) !== "CUSTOMER")
        return Promise.resolve({ status: "NOT_FOUND" });
      this.quoteEffects += 1;
      return Promise.resolve({
        quote: quote(this.targets[target], "CUSTOMER"),
        status: "APPLIED",
      });
    },
    submit: (input) =>
      this.providerCommand(
        input.actorUserId,
        this.targetFor("quoteId", input.quoteId),
      ),
  };

  public readonly structured: StructuredQuotePersistence = {
    readOwned: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      return Promise.resolve(
        this.canReadBilateral(input.actorUserId, target)
          ? structuredContent(input.quoteId)
          : null,
      );
    },
    saveDraft: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      if (this.role(input.actorUserId, target) !== "PROVIDER")
        return Promise.resolve({ status: "NOT_FOUND" });
      if (this.state === "TERMINAL_LINEAGE")
        return Promise.resolve({ status: "READ_ONLY" });
      this.quoteEffects += 1;
      return Promise.resolve({
        content: structuredContent(input.quoteId),
        status: "SAVED",
      });
    },
  };

  public readonly externalPdf: ExternalPdfQuotePersistence = {
    readOwned: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      return Promise.resolve(
        this.canReadBilateral(input.actorUserId, target)
          ? externalContent(input.quoteId)
          : null,
      );
    },
    saveDraft: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      if (this.role(input.actorUserId, target) !== "PROVIDER")
        return Promise.resolve({ status: "NOT_FOUND" });
      if (this.state === "TERMINAL_LINEAGE")
        return Promise.resolve({ status: "READ_ONLY" });
      this.quoteEffects += 1;
      return Promise.resolve({
        revision: externalContent(input.quoteId),
        status: "SAVED",
      });
    },
  };

  public readonly lifecycle: QuoteLifecyclePersistence = {
    readOwnedContext: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      return Promise.resolve(
        this.canReadBilateral(input.actorUserId, target)
          ? lifecycleContext(input.quoteId)
          : null,
      );
    },
    reconfirm: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      if (this.role(input.actorUserId, target) !== "PROVIDER") {
        return Promise.resolve({ status: "NOT_FOUND" as const });
      }
      this.lifecycleEffects += 1;
      return Promise.resolve({
        quote: {
          currentDraft: { revision: 2 },
          id: input.quoteId,
        },
        status: "APPLIED",
      } as never);
    },
    withdraw: (input) => {
      const target = this.targetFor("quoteId", input.quoteId);
      if (this.role(input.actorUserId, target) !== "PROVIDER") {
        return Promise.resolve({ status: "NOT_FOUND" as const });
      }
      this.lifecycleEffects += 1;
      return Promise.resolve({
        context: { ...lifecycleContext(input.quoteId), state: "WITHDRAWN" },
        status: "APPLIED",
      } as never);
    },
  };

  private readConversation(
    actorUserId: UserId,
    conversationId: ConversationId,
  ): Promise<Conversation | null> {
    const target = this.targetFor("conversationId", conversationId);
    return Promise.resolve(
      this.canReadBilateral(actorUserId, target)
        ? conversation(this.targets[target], actorUserId, target, this.state)
        : null,
    );
  }

  private readQuote(
    actorUserId: UserId,
    quoteId: QuoteId,
  ): Promise<Quote | null> {
    const target = this.targetFor("quoteId", quoteId);
    const role = this.role(actorUserId, target);
    return Promise.resolve(
      role === null ? null : quote(this.targets[target], role),
    );
  }

  private providerCommand(actorUserId: UserId, target: R3SecurityTarget) {
    if (this.role(actorUserId, target) !== "PROVIDER")
      return Promise.resolve({ status: "NOT_FOUND" as const });
    if (this.state === "TERMINAL_LINEAGE")
      return Promise.resolve({ status: "READ_ONLY" as const });
    this.quoteEffects += 1;
    return Promise.resolve({
      quote: quote(this.targets[target], "PROVIDER"),
      status: "APPLIED" as const,
    });
  }

  private canReadBilateral(
    actorUserId: UserId,
    target: R3SecurityTarget,
  ): boolean {
    return this.role(actorUserId, target) !== null;
  }

  private role(
    actorUserId: UserId,
    target: R3SecurityTarget,
  ): "CUSTOMER" | "PROVIDER" | null {
    const actor = this.actorById.get(actorUserId);
    if (target === "EXACT_OWN") {
      if (actor === "CUSTOMER_OWNER" || actor === "SUSPENDED_CUSTOMER_OWNER")
        return "CUSTOMER";
      if (actor === "PROVIDER_OWNER" || actor === "SUSPENDED_PROVIDER_OWNER")
        return "PROVIDER";
    }
    if (target === "COMPETITOR_SAME_REQUEST") {
      if (actor === "CUSTOMER_OWNER") return "CUSTOMER";
      if (actor === "COMPETING_PROVIDER") return "PROVIDER";
    }
    return null;
  }

  private targetFor<K extends keyof TargetIds>(
    kind: K,
    id: TargetIds[K],
  ): R3SecurityTarget {
    for (const target of Object.keys(this.targets) as R3SecurityTarget[]) {
      if (this.targets[target][kind] === id) return target;
    }
    return "UNKNOWN_UUID";
  }
}

async function createFixture(): Promise<Fixture> {
  const auth = new TestAuthPersistence();
  const actorById = new Map<UserId, R3SecurityActor>();
  for (const [index, actor] of R3_SECURITY_ACTOR_ORDER.entries()) {
    const userId = uuid(100 + index) as UserId;
    actorById.set(userId, actor);
    auth.addUser(
      userId,
      actor.startsWith("SUSPENDED_") ? "SUSPENDED" : "ACTIVE",
    );
  }
  const targets = createTargets();
  const ports = new BoundaryPorts(actorById, targets);
  const app = buildApi({
    auth: {
      config: {
        appOrigin,
        cookieName,
        cookieSecure: false,
        passwordResetTtlMs: 3_600_000,
        rateLimitMax: 10_000,
        rateLimitWindowMs: 60_000,
        sessionSecret: "r3-http-test-session-secret-at-least-32-characters",
        sessionTtlMs: 86_400_000,
        trustProxyHops: 0,
      },
      conversationChat: {
        admission: { admit: () => Promise.resolve("ADMITTED") },
        persistence: ports.chat,
        service: ports.chat,
      },
      conversations: { conversations: ports.conversations },
      jobInvitations: { invitations: ports.invitations },
      persistence: auth,
      quoteComparison: { comparison: ports.comparison },
      quoteAuthoring: {
        core: ports.quotes,
        externalPdf: ports.externalPdf,
        structured: ports.structured,
      },
      quoteLifecycle: { lifecycle: ports.lifecycle },
    },
    database: { ping: () => Promise.resolve() },
  });
  openApps.push(app);
  await app.ready();
  const sessions: Partial<Record<R3SecurityActor, SessionHandle>> = {};
  for (const [userId, actor] of actorById) {
    const response = await app.inject({
      method: "GET",
      url: AUTH_API_PATHS.csrf,
    });
    const cookie = responseCookie(response.headers["set-cookie"]);
    const csrfToken = response.json<{ csrfToken: string }>().csrfToken;
    auth.bindLastSession(userId);
    sessions[actor] = { cookie, csrfToken };
  }
  const anonymousResponse = await app.inject({
    method: "GET",
    url: AUTH_API_PATHS.csrf,
  });
  const anonymousSession = {
    cookie: responseCookie(anonymousResponse.headers["set-cookie"]),
    csrfToken: anonymousResponse.json<{ csrfToken: string }>().csrfToken,
  };
  const fixtureBase = {
    anonymousSession,
    app,
    ports,
    sessions: Object.freeze(sessions),
    targets,
  };
  return Object.freeze({
    ...fixtureBase,
    adapter: createHttpAdapter(fixtureBase),
  });
}

function createHttpAdapter(
  fixture: Omit<Fixture, "adapter">,
): R3HttpSecurityMatrixAdapter {
  return Object.freeze({
    privateMarkers: [privateMarker],
    async probe(testCase: R3HttpSecurityCase) {
      fixture.ports.state = testCase.state;
      const session = fixture.sessions[testCase.actor];
      if (session === undefined) throw new Error("Missing R3 actor session.");
      if (testCase.action !== "COMMAND") {
        return injectCase(fixture, testCase, session);
      }
      const csrfMissing = await injectCase(fixture, testCase, {
        cookie: session.cookie,
      });
      const csrfWrong = await injectCase(fixture, testCase, {
        ...session,
        csrfToken: "wrong-token",
      });
      const result = await injectCase(fixture, testCase, session);
      return { ...result, csrfMissing, csrfWrong };
    },
    probeAnonymous(testCase: R3HttpSecurityCase) {
      fixture.ports.state = testCase.state;
      return injectCase(fixture, testCase, fixture.anonymousSession);
    },
    async probeCors(): Promise<R3HttpCorsEvidence> {
      const path = invitationPath(fixture.targets.EXACT_OWN.invitationId);
      const allowed = await fixture.app.inject({
        headers: {
          "access-control-request-method": "GET",
          origin: appOrigin,
        },
        method: "OPTIONS",
        url: path,
      });
      const denied = await fixture.app.inject({
        headers: {
          "access-control-request-method": "GET",
          origin: "https://attacker.example.test",
        },
        method: "OPTIONS",
        url: path,
      });
      return {
        allowedOrigin: appOrigin,
        allowedPreflight: responseEvidence(allowed),
        disallowedPreflight: responseEvidence(denied),
      };
    },
  });
}

async function injectCase(
  fixture: Omit<Fixture, "adapter">,
  testCase: R3HttpSecurityCase,
  session: Partial<SessionHandle>,
): Promise<R3HttpBoundaryResult> {
  const target = fixture.targets[testCase.target];
  const before = fixture.ports.messageEffects;
  const request = requestFor(testCase, target, session);
  const response = await fixture.app.inject(request);
  return responseEvidence(
    response,
    testCase.action === "COMMAND" ? before : undefined,
    testCase.action === "COMMAND" ? fixture.ports.messageEffects : undefined,
  );
}

function requestFor(
  testCase: R3HttpSecurityCase,
  target: TargetIds,
  session: Partial<SessionHandle>,
): HttpRequestSpec {
  const headers = {
    ...(session.cookie === undefined ? {} : { cookie: session.cookie }),
    ...(session.csrfToken === undefined
      ? {}
      : { "x-csrf-token": session.csrfToken }),
  };
  switch (testCase.surface) {
    case "INVITATION_DETAIL":
      return {
        headers,
        method: "GET" as const,
        url: invitationPath(target.invitationId),
      };
    case "CONVERSATION":
      return {
        headers,
        method: "GET" as const,
        url: conversationPath(CONVERSATION_PATHS.byId, target.conversationId),
      };
    case "CONVERSATION_TIMELINE":
      return {
        headers,
        method: "GET" as const,
        url: conversationPath(
          CONVERSATION_PATHS.timeline,
          target.conversationId,
        ),
      };
    case "CONVERSATION_WRITE":
      return {
        headers,
        method: "POST" as const,
        payload: {
          body: "R3 HTTP security command",
          commandId: randomUUID(),
        },
        url: conversationPath(
          CONVERSATION_PATHS.messages,
          target.conversationId,
        ),
      };
    case "QUOTE_COMPARISON":
      return {
        headers,
        method: "GET" as const,
        url: QUOTE_COMPARISON_PATH.replace(
          ":jobRequestId",
          target.jobRequestId,
        ),
      };
  }
}

async function expectStatus(
  fixture: Fixture,
  session: Partial<SessionHandle>,
  method: "GET" | "POST",
  url: string,
  statusCode: number,
  code?: string,
  payload?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const response = await fixture.app.inject({
    headers: {
      ...(session.cookie === undefined ? {} : { cookie: session.cookie }),
      ...(session.csrfToken === undefined
        ? {}
        : { "x-csrf-token": session.csrfToken }),
    },
    method,
    ...(payload === undefined ? {} : { payload }),
    url,
  });
  expect(response.statusCode).toBe(statusCode);
  expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  if (code !== undefined) {
    expect(response.json<{ code: string }>().code).toBe(code);
  }
  expect(response.body).not.toContain(privateMarker);
}

function responseEvidence(
  response: LightMyRequestResponse,
  effectCountBefore?: number,
  effectCountAfter?: number,
): R3HttpBoundaryResult {
  return {
    body: response.body.length === 0 ? {} : response.json<unknown>(),
    ...(effectCountAfter === undefined ? {} : { effectCountAfter }),
    ...(effectCountBefore === undefined ? {} : { effectCountBefore }),
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(", ") : String(value ?? ""),
      ]),
    ),
    statusCode: response.statusCode,
  };
}

function invitation(
  target: TargetIds,
  actorUserId: UserId,
  relation: R3SecurityTarget,
): JobInvitationDetail {
  const role =
    actorUserId === actorId("CUSTOMER_OWNER") ? "CUSTOMER" : "CRAFTSMAN";
  return {
    changedAt: now,
    competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS",
    counterpartDisplayName: `${privateMarker}:${relation}`,
    customerTrust: {
      permittedReviewComments: [],
      rating: null,
      reviewCount: 0,
    },
    displayedRequestContentRevision: 2,
    displayedRequestVisibleVersion: 1,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    id: target.invitationId,
    jobRequestId: target.jobRequestId,
    perspective: role,
    request: {
      approximateDistanceKm: 10,
      budget: {
        currency: "EUR",
        maximumAmountCents: 200_000,
        minimumAmountCents: 100_000,
        mode: "RANGE",
      },
      description: privateMarker,
      details: {
        approximateQuantity: null,
        customRequirements: null,
        materialResponsibility: "COMBINATION",
        siteInspection: "MAYBE",
      },
      documentMediaAssetIds: [],
      municipalityCode: "MUN:TEST",
      photoMediaAssetIds: [],
      primaryProfessionCode: "PROF:TEST",
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      timing: {
        completionDeadline: null,
        endsOn: null,
        mode: "FLEXIBLE",
        startsOn: null,
      },
      title: privateMarker,
    },
    requestContentRevision: 2,
    requestTitle: privateMarker,
    requestVisibleVersion: 1,
    revision: 2,
    state: "ENGAGED",
  };
}

function conversation(
  target: TargetIds,
  actorUserId: UserId,
  relation: R3SecurityTarget,
  state: R3SecurityState,
): Conversation {
  return {
    access: state === "TERMINAL_LINEAGE" ? "READ_ONLY" : "WRITABLE",
    counterpartDisplayName: `${privateMarker}:${relation}`,
    craftsmanProfileId: uuid(802) as never,
    createdAt: now,
    customerProfileId: uuid(803) as never,
    id: target.conversationId,
    invitationId: target.invitationId,
    jobRequestId: target.jobRequestId,
    participantRole:
      actorUserId === actorId("CUSTOMER_OWNER") ? "CUSTOMER" : "CRAFTSMAN",
    requestTitle: privateMarker,
  };
}

function timeline(target: TargetIds, state: R3SecurityState) {
  return {
    entries: [messageEntry(target)],
    hasMore: false,
    nextBeforeSequence: null,
    participantState: {
      archived: state === "TERMINAL_LINEAGE",
      lastReadAt: null,
      lastReadSequence: 0,
      muted: false,
      revision: 1,
    },
    unreadCount: 1,
  };
}

function messageEntry(target: TargetIds) {
  return {
    attachments: [],
    author: "SELF" as const,
    authorRole: "CRAFTSMAN" as const,
    body: privateMarker,
    conversationId: target.conversationId,
    createdAt: now,
    id: uuid(900) as never,
    kind: "HUMAN_MESSAGE" as const,
    hiddenByModeration: false,
    readByCounterpart: null,
    replyToMessageId: null,
    sequence: 1,
    systemEvent: null,
  };
}

function lifecycleContext(quoteId: QuoteId) {
  return {
    authoringEligible: true,
    authoringMode: "PLATFORM_STRUCTURED" as const,
    currentRequestContentRevision: 2,
    currentRequestVisibleVersion: 1,
    deadlinePassed: false,
    lifecycleAcceptanceEligible: true,
    materiallyStale: false,
    quoteId,
    quoteRevision: 1,
    requestContentRevision: 2,
    requestVisibleVersion: 1,
    state: "SUBMITTED" as const,
    stateRevision: 2,
    validUntil: null,
  };
}

function quote(target: TargetIds, role: "CUSTOMER" | "PROVIDER" | null): Quote {
  const revision = {
    authoringMode: "PLATFORM_STRUCTURED" as const,
    changedAt: now,
    createdAt: now,
    rejectionReason: null,
    requestContentRevision: 2,
    requestVisibleVersion: 1,
    revision: 1,
    state: "DRAFT" as const,
    stateRevision: 1,
    submittedAt: null,
  };
  return {
    conversationId: target.conversationId,
    createdAt: now,
    currentDraft: revision,
    currentSubmitted: null,
    id: target.quoteId,
    invitationId: target.invitationId,
    jobRequestId: target.jobRequestId,
    participantRole: role === "CUSTOMER" ? "CUSTOMER" : "CRAFTSMAN",
    revisions: [revision],
  };
}

function structuredContent(quoteId: QuoteId): StructuredQuoteContentRevision {
  const emptyComponent = { amountCents: null, description: null };
  return {
    changedAt: now,
    components: {
      labor: emptyComponent,
      material: emptyComponent,
      other: emptyComponent,
      transport: emptyComponent,
    },
    conditionalOnInspection: false,
    contentRevision: 1,
    currency: "EUR",
    depositAmountCents: null,
    depositMode: null,
    depositNotes: null,
    depositPercentageBasisPoints: null,
    estimatedDurationDays: null,
    estimatedStartOn: null,
    excludedScope: [],
    includedScope: [],
    inspectionConditions: null,
    materialResponsibility: "PROVIDER",
    priceBasis: "Cena za celé dielo",
    priceMode: "FIXED",
    providerNotes: null,
    quoteId,
    quoteRevision: 1,
    rangeMaximumCents: null,
    rangeMinimumCents: null,
    summary: "Bezpečný súhrn ponuky",
    title: "Ponuka remeselníka",
    totalAmountCents: 100_000,
    validUntil: null,
    vatStatus: "VAT_INCLUDED",
    warrantyInformation: null,
  };
}

function externalContent(quoteId: QuoteId): ExternalPdfQuoteRevision {
  return {
    confirmedAt: now,
    contentRevision: 1,
    currency: "EUR",
    depositAmountCents: null,
    depositMode: null,
    depositPercentageBasisPoints: null,
    estimatedDurationDays: null,
    estimatedStartOn: null,
    materialResponsibility: null,
    pdfAssetId: uuid(950),
    pdfDownloadPath: `/v1/media/${uuid(950)}/download`,
    priceMode: "FIXED",
    providerConfirmedSummaryMatchesPdf: true,
    quoteId,
    quoteRevision: 1,
    rangeMaximumCents: null,
    rangeMinimumCents: null,
    savedAt: now,
    totalAmountCents: 100_000,
    validUntil: null,
    vatStatus: "VAT_INCLUDED",
  };
}

function structuredSaveBody() {
  return {
    commandId: randomUUID(),
    content: {
      components: {},
      conditionalOnInspection: false,
      currency: "EUR",
      materialResponsibility: "PROVIDER",
      priceBasis: "Cena za celé dielo",
      priceMode: "FIXED",
      summary: "Bezpečný súhrn ponuky",
      title: "Ponuka remeselníka",
      totalAmountCents: 100_000,
      vatStatus: "VAT_INCLUDED",
    },
    expectedContentRevision: 0,
  };
}

function externalSaveBody() {
  return {
    commandId: randomUUID(),
    envelope: {
      currency: "EUR",
      priceMode: "FIXED",
      providerConfirmedSummaryMatchesPdf: true,
      totalAmountCents: 100_000,
      vatStatus: "VAT_INCLUDED",
    },
    expectedContentRevision: 0,
    pdfAssetId: uuid(950),
  };
}

const R3_SECURITY_ACTOR_ORDER = [
  "CUSTOMER_OWNER",
  "PROVIDER_OWNER",
  "COMPETING_PROVIDER",
  "UNRELATED_CUSTOMER",
  "UNINVITED_PROVIDER",
  "UNRELATED_COMBINED",
  "ADMIN_ROLE_ONLY",
  "SUPERADMIN_ROLE_ONLY",
  "SUSPENDED_CUSTOMER_OWNER",
  "SUSPENDED_PROVIDER_OWNER",
] as const satisfies readonly R3SecurityActor[];

function createTargets(): Readonly<Record<R3SecurityTarget, TargetIds>> {
  const targets = Object.fromEntries(
    (
      [
        "EXACT_OWN",
        "COMPETITOR_SAME_REQUEST",
        "FOREIGN_REQUEST",
        "UNKNOWN_UUID",
        "WRONG_KIND_UUID",
      ] as const
    ).map((target, index) => [
      target,
      Object.freeze({
        conversationId: uuid(200 + index * 10) as ConversationId,
        invitationId: uuid(201 + index * 10) as JobInvitationId,
        jobRequestId: uuid(202 + index * 10) as JobRequestId,
        quoteId: uuid(203 + index * 10) as QuoteId,
      }),
    ]),
  );
  return Object.freeze(targets) as Readonly<
    Record<R3SecurityTarget, TargetIds>
  >;
}

function actorId(actor: R3SecurityActor): UserId {
  const index = R3_SECURITY_ACTOR_ORDER.indexOf(actor);
  if (index < 0) throw new Error("Unknown R3 HTTP actor.");
  return uuid(100 + index) as UserId;
}

function uuid(serial: number): string {
  return `00000000-0000-4000-8000-${serial.toString().padStart(12, "0")}`;
}

function invitationPath(invitationId: JobInvitationId): string {
  return JOB_INVITATION_PATHS.detail.replace(":invitationId", invitationId);
}

function conversationPath(
  template: string,
  conversationId: ConversationId,
): string {
  return template.replace(":conversationId", conversationId);
}

function lifecyclePath(template: string, quoteId: QuoteId): string {
  return template.replace(":quoteId", quoteId);
}

function authoringPath(template: string, target: TargetIds): string {
  return template
    .replace(":conversationId", target.conversationId)
    .replace(":invitationId", target.invitationId)
    .replace(":quoteId", target.quoteId)
    .replace(":quoteRevision", "1");
}

function requiredSession(
  fixture: Fixture,
  actor: R3SecurityActor,
): SessionHandle {
  const session = fixture.sessions[actor];
  if (session === undefined) throw new Error(`Missing ${actor} session.`);
  return session;
}

function responseCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Expected R3 HTTP session cookie.");
  return value.split(";", 1)[0] ?? "";
}
