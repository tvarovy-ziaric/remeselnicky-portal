import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const CUSTOMER_SHORTLIST_PATHS = Object.freeze({
  add: "/v1/me/shortlist/add",
  list: "/v1/me/shortlist",
  remove: "/v1/me/shortlist/remove",
} as const);

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

interface ShortlistService {
  add(input: ShortlistCommand): Promise<ShortlistResult>;
  list(actorUserId: UserId): Promise<
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | {
        readonly status: "OK";
        readonly entries: readonly {
          readonly craftsmanProfileId: string;
          readonly revision: number;
          readonly savedAt: Date;
          readonly targetAvailable: boolean;
        }[];
      }
  >;
  remove(input: ShortlistCommand): Promise<ShortlistResult>;
}

interface ShortlistCommand {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
}

type ShortlistResult =
  | { readonly status: "ACCOUNT_NOT_ACTIVE" | "TARGET_NOT_AVAILABLE" }
  | {
      readonly activeShortlistSize?: number;
      readonly revision: number;
      readonly state: "ACTIVE" | "REMOVED";
      readonly status: "APPLIED" | "UNCHANGED" | "DEDUPLICATED";
    };

export interface CustomerShortlistRouteDependencies {
  readonly csrfProtection?: onRequestHookHandler;
  readonly guard: Guard;
  readonly onApplied?: (input: {
    readonly activeShortlistSize: number;
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly state: "ACTIVE" | "REMOVED";
  }) => Promise<void>;
  readonly shortlist: ShortlistService;
}

export function registerCustomerShortlistRoutes(
  app: FastifyInstance,
  dependencies: CustomerShortlistRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/me/shortlist")) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get(CUSTOMER_SHORTLIST_PATHS.list, async (request, reply) => {
    const actor = await requireActiveActor(request, reply, dependencies.guard);
    if (actor === undefined) return;
    const result = await dependencies.shortlist.list(actor);
    if (result.status === "ACCOUNT_NOT_ACTIVE") {
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    }
    return reply.send({
      items: result.entries.map((entry) => ({
        availability: entry.targetAvailable ? "AVAILABLE" : "UNAVAILABLE",
        craftsmanProfileId: entry.craftsmanProfileId,
        revision: entry.revision,
        savedAt: entry.savedAt.toISOString(),
      })),
    });
  });

  const writeOptions = {
    onRequest: dependencies.csrfProtection ?? csrfProtection(app),
    schema: { body: commandSchema },
  } as const;
  app.post<{ Body: { commandId: string; craftsmanProfileId: string } }>(
    CUSTOMER_SHORTLIST_PATHS.add,
    writeOptions,
    async (request, reply) => runCommand("add", request, reply, dependencies),
  );
  app.post<{ Body: { commandId: string; craftsmanProfileId: string } }>(
    CUSTOMER_SHORTLIST_PATHS.remove,
    writeOptions,
    async (request, reply) =>
      runCommand("remove", request, reply, dependencies),
  );
}

async function runCommand(
  kind: "add" | "remove",
  request: FastifyRequest<{
    Body: { commandId: string; craftsmanProfileId: string };
  }>,
  reply: FastifyReply,
  dependencies: CustomerShortlistRouteDependencies,
) {
  const actorUserId = await requireActiveActor(
    request,
    reply,
    dependencies.guard,
  );
  if (actorUserId === undefined) return;
  try {
    const result = await dependencies.shortlist[kind]({
      actorUserId,
      commandId: request.body.commandId,
      craftsmanProfileId: request.body.craftsmanProfileId as CraftsmanProfileId,
    });
    if (result.status === "ACCOUNT_NOT_ACTIVE")
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    if (result.status === "TARGET_NOT_AVAILABLE")
      return reply.code(404).send({ code: "NOT_FOUND" });
    const activeShortlistSize =
      "activeShortlistSize" in result ? result.activeShortlistSize : undefined;
    if (
      result.status === "APPLIED" &&
      typeof activeShortlistSize === "number" &&
      Number.isSafeInteger(activeShortlistSize) &&
      activeShortlistSize >= 0 &&
      dependencies.onApplied !== undefined
    ) {
      try {
        await dependencies.onApplied({
          activeShortlistSize,
          actorUserId,
          commandId: request.body.commandId,
          state: result.state,
        });
      } catch {
        // The domain transaction is already committed; analytics is best-effort
        // and must never change the command response.
      }
    }
    return reply.code(204).send();
  } catch (error: unknown) {
    if (isAccountNotActive(error))
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    if (isIdempotencyConflict(error))
      return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
    return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
  }
}

function isAccountNotActive(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE"
  );
}

async function requireActiveActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  return result.user.id;
}

function isIdempotencyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CUSTOMER_SHORTLIST_IDEMPOTENCY_CONFLICT"
  );
}

function csrfProtection(app: FastifyInstance): onRequestHookHandler {
  return (request, reply, done): void =>
    app.csrfProtection(request, reply, done);
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const commandSchema = {
  additionalProperties: false,
  properties: { commandId: uuid, craftsmanProfileId: uuid },
  required: ["commandId", "craftsmanProfileId"],
  type: "object",
} as const;
