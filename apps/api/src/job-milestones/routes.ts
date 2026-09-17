import type { UserId } from "@portal/domain";
import { JobMilestoneIdempotencyError } from "@portal/db";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_MILESTONE_PATHS = Object.freeze({
  collection: "/v1/me/jobs/:jobId/milestones",
  detail: "/v1/me/jobs/:jobId/milestones/:milestoneId",
  history: "/v1/me/jobs/:jobId/milestones/:milestoneId/history",
  edit: "/v1/me/jobs/:jobId/milestones/:milestoneId/edit",
  state: "/v1/me/jobs/:jobId/milestones/:milestoneId/state",
  reorder: "/v1/me/jobs/:jobId/milestones/:milestoneId/reorder",
  assign: "/v1/me/jobs/:jobId/milestones/:milestoneId/assign",
  acknowledge: "/v1/me/jobs/:jobId/milestones/:milestoneId/acknowledge",
});

type MilestoneState = "PLANNED" | "IN_PROGRESS" | "DONE" | "SKIPPED";
type Responsibility = Readonly<{
  kind: "PARTICIPANT" | "WORK_GROUP";
  id: string;
}>;
interface MilestoneCapabilities {
  readonly canEdit: boolean;
  readonly canSetState: boolean;
  readonly canMarkDone: boolean;
  readonly canReorder: boolean;
  readonly canAssign: boolean;
  readonly canAcknowledge: boolean;
}
interface MilestoneItem {
  readonly id: string;
  readonly jobId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: MilestoneState;
  readonly orderIndex: number;
  readonly originalPlannedStartOn: string | null;
  readonly originalPlannedEndOn: string | null;
  readonly currentPlannedStartOn: string | null;
  readonly currentPlannedEndOn: string | null;
  readonly acceptedStageLabel: string | null;
  readonly sourceQuoteId: string | null;
  readonly sourceQuoteRevision: number | null;
  readonly sourcePdfDownloadPath: string | null;
  readonly sourceChangeOrderRevisionId: string | null;
  readonly responsibility: Responsibility | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly capabilities: MilestoneCapabilities;
}
interface MilestoneCursor {
  readonly orderIndex: number;
  readonly id: string;
}
interface MilestonePage {
  readonly items: readonly MilestoneItem[];
  readonly canCreate: boolean;
  readonly nextCursor: MilestoneCursor | null;
}
interface MilestoneHistoryEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: "CREATE" | "EDIT" | "STATE" | "REORDER" | "ASSIGN";
  readonly actorUserId: string;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly state: MilestoneState;
  readonly orderKey: string;
  readonly responsibility: Responsibility | null;
  readonly acceptedStageLabel: string | null;
  readonly sourceQuoteId: string | null;
  readonly sourceQuoteRevision: number | null;
  readonly sourcePdfDownloadPath: string | null;
  readonly sourceChangeOrderRevisionId: string | null;
  readonly recordedAt: Date;
}
interface MilestoneHistoryPage {
  readonly items: readonly MilestoneHistoryEvent[];
  readonly nextCursor: number | null;
}
type CommandResult =
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly milestoneId: string;
    }
  | { readonly status: "NOT_FOUND" | "STALE_STATE" };

export interface JobMilestoneRouteDependencies {
  readonly milestones: {
    list(input: {
      actorUserId: string;
      jobId: string;
      limit: number;
      cursor?: MilestoneCursor;
    }): Promise<MilestonePage | null>;
    get(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
    }): Promise<MilestoneItem | null>;
    listHistory(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
      limit: number;
      beforeSequence?: number;
    }): Promise<MilestoneHistoryPage | null>;
    create(input: {
      actorUserId: string;
      jobId: string;
      commandId: string;
      title: string;
      description?: string | null;
      plannedStartOn?: string | null;
      plannedEndOn?: string | null;
      acceptedStageLabel?: string | null;
      sourceChangeOrderRevisionId?: string | null;
      responsibility?: Responsibility | null;
    }): Promise<CommandResult>;
    edit(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
      commandId: string;
      title: string;
      description?: string | null;
      plannedStartOn?: string | null;
      plannedEndOn?: string | null;
      sourceChangeOrderRevisionId?: string | null;
    }): Promise<CommandResult>;
    setState(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
      commandId: string;
      state: MilestoneState;
    }): Promise<CommandResult>;
    reorder(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
      commandId: string;
      afterMilestoneId: string | null;
    }): Promise<CommandResult>;
    assign(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
      commandId: string;
      responsibility: Responsibility | null;
    }): Promise<CommandResult>;
    acknowledge(input: {
      actorUserId: string;
      jobId: string;
      milestoneId: string;
      commandId: string;
    }): Promise<CommandResult>;
  };
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

interface CollectionQuery {
  readonly limit?: number;
  readonly afterOrder?: number;
  readonly afterId?: string;
}
interface HistoryQuery {
  readonly limit?: number;
  readonly beforeSequence?: number;
}
interface DetailParams {
  readonly jobId: string;
  readonly milestoneId: string;
}
interface PlanBody {
  readonly commandId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly plannedStartOn?: string | null;
  readonly plannedEndOn?: string | null;
  readonly sourceChangeOrderRevisionId?: string | null;
}
interface CreateBody extends PlanBody {
  readonly acceptedStageLabel?: string | null;
  readonly responsibility?: Responsibility | null;
}
interface EditBody extends PlanBody {
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
}

export function registerJobMilestoneRoutes(
  app: FastifyInstance,
  dependencies: JobMilestoneRouteDependencies,
): void {
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
  };
  const command = { ...common, onRequest: dependencies.csrfProtection };

  app.get<{ Params: { jobId: string }; Querystring: CollectionQuery }>(
    JOB_MILESTONE_PATHS.collection,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { params: jobParams, querystring: collectionQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      const cursor = parseCursor(request.query, reply);
      if (cursor === false) return;
      try {
        const page = await dependencies.milestones.list({
          actorUserId: actor,
          jobId: request.params.jobId,
          limit: request.query.limit ?? 20,
          ...(cursor === null ? {} : { cursor }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              items: page.items.map(serializeItem),
              canCreate: page.canCreate,
              nextCursor:
                page.nextCursor === null
                  ? null
                  : {
                      afterOrder: page.nextCursor.orderIndex,
                      afterId: page.nextCursor.id,
                    },
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: DetailParams }>(
    JOB_MILESTONE_PATHS.detail,
    { ...common, onRequest: rejectAnyQuery, schema: { params: detailParams } },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const item = await dependencies.milestones.get({
          actorUserId: actor,
          jobId: request.params.jobId,
          milestoneId: request.params.milestoneId,
        });
        return item === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeItem(item));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: DetailParams; Querystring: HistoryQuery }>(
    JOB_MILESTONE_PATHS.history,
    {
      ...common,
      onRequest: exactQuery(["limit", "beforeSequence"]),
      schema: { params: detailParams, querystring: historyQuery },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const page = await dependencies.milestones.listHistory({
          actorUserId: actor,
          jobId: request.params.jobId,
          milestoneId: request.params.milestoneId,
          limit: request.query.limit ?? 20,
          ...(request.query.beforeSequence === undefined
            ? {}
            : { beforeSequence: request.query.beforeSequence }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              items: page.items.map((event) => ({
                ...event,
                recordedAt: event.recordedAt.toISOString(),
              })),
              nextCursor: page.nextCursor,
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { jobId: string }; Body: CreateBody }>(
    JOB_MILESTONE_PATHS.collection,
    {
      ...command,
      preValidation: exactBody(
        ["commandId", "title"],
        [
          "description",
          "plannedStartOn",
          "plannedEndOn",
          "acceptedStageLabel",
          "sourceChangeOrderRevisionId",
          "responsibility",
        ],
      ),
      schema: { params: jobParams, body: createBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      if (
        !validPlan(request.body) ||
        (request.body.acceptedStageLabel != null &&
          request.body.sourceChangeOrderRevisionId != null)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        return sendCommand(
          reply,
          await dependencies.milestones.create({
            actorUserId: actor,
            jobId: request.params.jobId,
            ...request.body,
          }),
          true,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: DetailParams; Body: EditBody }>(
    JOB_MILESTONE_PATHS.edit,
    {
      ...command,
      preValidation: exactBody(
        ["commandId", "title", "description", "plannedStartOn", "plannedEndOn"],
        ["sourceChangeOrderRevisionId"],
      ),
      schema: { params: detailParams, body: editBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      if (!validPlan(request.body))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        return sendCommand(
          reply,
          await dependencies.milestones.edit({
            actorUserId: actor,
            jobId: request.params.jobId,
            milestoneId: request.params.milestoneId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: DetailParams;
    Body: { commandId: string; state: MilestoneState };
  }>(
    JOB_MILESTONE_PATHS.state,
    {
      ...command,
      preValidation: exactBody(["commandId", "state"]),
      schema: { params: detailParams, body: stateBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.milestones.setState({
            actorUserId: actor,
            jobId: request.params.jobId,
            milestoneId: request.params.milestoneId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: DetailParams;
    Body: { commandId: string; afterMilestoneId: string | null };
  }>(
    JOB_MILESTONE_PATHS.reorder,
    {
      ...command,
      preValidation: exactBody(["commandId", "afterMilestoneId"]),
      schema: { params: detailParams, body: reorderBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      if (request.body.afterMilestoneId === request.params.milestoneId)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        return sendCommand(
          reply,
          await dependencies.milestones.reorder({
            actorUserId: actor,
            jobId: request.params.jobId,
            milestoneId: request.params.milestoneId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: DetailParams;
    Body: { commandId: string; responsibility: Responsibility | null };
  }>(
    JOB_MILESTONE_PATHS.assign,
    {
      ...command,
      preValidation: exactBody(["commandId", "responsibility"]),
      schema: { params: detailParams, body: assignBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.milestones.assign({
            actorUserId: actor,
            jobId: request.params.jobId,
            milestoneId: request.params.milestoneId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: DetailParams; Body: { commandId: string } }>(
    JOB_MILESTONE_PATHS.acknowledge,
    {
      ...command,
      preValidation: exactBody(["commandId"]),
      schema: { params: detailParams, body: acknowledgeBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.milestones.acknowledge({
            actorUserId: actor,
            jobId: request.params.jobId,
            milestoneId: request.params.milestoneId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobMilestoneRouteDependencies,
): Promise<string | null> {
  const result = await dependencies.guard.evaluate(request);
  if (result.status === "ACTIVE") return result.user.id;
  void reply
    .code(result.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: result.status });
  return null;
}
function parseCursor(
  query: CollectionQuery,
  reply: FastifyReply,
): MilestoneCursor | null | false {
  if ((query.afterOrder === undefined) !== (query.afterId === undefined)) {
    void reply.code(400).send({ code: "INVALID_CURSOR" });
    return false;
  }
  if (query.afterOrder === undefined || query.afterId === undefined)
    return null;
  return { orderIndex: query.afterOrder, id: query.afterId };
}
function serializeItem(item: MilestoneItem) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    acknowledgedAt: item.acknowledgedAt?.toISOString() ?? null,
  };
}
function sendCommand(
  reply: FastifyReply,
  result: CommandResult,
  created = false,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(created && result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      milestoneId: result.milestoneId,
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendError(reply: FastifyReply, error: unknown) {
  const conflict = error instanceof JobMilestoneIdempotencyError;
  return reply
    .code(error instanceof TypeError ? 400 : conflict ? 409 : 503)
    .send({
      code:
        error instanceof TypeError
          ? "INVALID_REQUEST"
          : conflict
            ? "IDEMPOTENCY_CONFLICT"
            : "TEMPORARILY_UNAVAILABLE",
    });
}
function validDate(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function validPlan(body: PlanBody): boolean {
  if (!validDate(body.plannedStartOn) || !validDate(body.plannedEndOn))
    return false;
  return (
    body.plannedStartOn === undefined ||
    body.plannedEndOn === undefined ||
    body.plannedStartOn === null ||
    body.plannedEndOn === null ||
    body.plannedStartOn <= body.plannedEndOn
  );
}
function rejectUnknownQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  const keys = [
    ...new URL(request.raw.url ?? "", "http://localhost").searchParams.keys(),
  ];
  if (
    keys.some((key) => !["limit", "afterOrder", "afterId"].includes(key)) ||
    new Set(keys).size !== keys.length
  ) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
}
function exactQuery(allowed: readonly string[]) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const keys = [
      ...new URL(request.raw.url ?? "", "http://localhost").searchParams.keys(),
    ];
    if (
      keys.some((key) => !allowed.includes(key)) ||
      new Set(keys).size !== keys.length
    ) {
      void reply.code(400).send({ code: "INVALID_QUERY" });
      return;
    }
    done();
  };
}
function rejectAnyQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (new URL(request.raw.url ?? "", "http://localhost").searchParams.size) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
}
function exactBody(
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (
      typeof request.body !== "object" ||
      request.body === null ||
      Array.isArray(request.body) ||
      required.some((key) => !Object.hasOwn(request.body as object, key)) ||
      Object.keys(request.body).some(
        (key) => !required.includes(key) && !optional.includes(key),
      )
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}
function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
) {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}

const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const calendarDate = {
  anyOf: [
    { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    { type: "null" },
  ],
} as const;
const optionalText = (maximum: number) => ({
  anyOf: [
    { type: "string", minLength: 1, maxLength: maximum },
    { type: "null" },
  ],
});
const responsibility = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: {
        kind: { type: "string", enum: ["PARTICIPANT", "WORK_GROUP"] },
        id: uuid,
      },
    },
    { type: "null" },
  ],
} as const;
const jobParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: uuid },
} as const;
const detailParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "milestoneId"],
  properties: { jobId: uuid, milestoneId: uuid },
} as const;
const collectionQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 20 },
    afterOrder: { type: "integer", minimum: 0 },
    afterId: uuid,
  },
} as const;
const historyQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 20 },
    beforeSequence: { type: "integer", minimum: 1, maximum: 2147483647 },
  },
} as const;
const planProperties = {
  commandId: uuid,
  title: { type: "string", minLength: 1, maxLength: 160 },
  description: optionalText(2_000),
  plannedStartOn: calendarDate,
  plannedEndOn: calendarDate,
  sourceChangeOrderRevisionId: { anyOf: [uuid, { type: "null" }] },
};
const planBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "title"],
  properties: planProperties,
} as const;
const editBody = {
  ...planBody,
  required: [
    "commandId",
    "title",
    "description",
    "plannedStartOn",
    "plannedEndOn",
  ],
} as const;
const createBody = {
  ...planBody,
  properties: {
    ...planProperties,
    acceptedStageLabel: optionalText(160),
    responsibility,
  },
} as const;
const stateBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "state"],
  properties: {
    commandId: uuid,
    state: {
      type: "string",
      enum: ["PLANNED", "IN_PROGRESS", "DONE", "SKIPPED"],
    },
  },
} as const;
const reorderBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "afterMilestoneId"],
  properties: {
    commandId: uuid,
    afterMilestoneId: { anyOf: [uuid, { type: "null" }] },
  },
} as const;
const assignBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "responsibility"],
  properties: { commandId: uuid, responsibility },
} as const;
const acknowledgeBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: { commandId: uuid },
} as const;
