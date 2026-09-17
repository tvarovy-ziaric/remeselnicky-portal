import type { UserId } from "@portal/domain";
import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import {
  MEDIA_UPLOAD_LIMITS,
  MediaUploadRejectedError,
  type ChangeOrderDocumentUploadService,
} from "@portal/media";
import {
  ChangeOrderIdempotencyError,
  type ChangeOrderCommandResult,
  type ChangeOrderTerms,
  type createChangeOrderRepository,
  type createChangeOrderPdfUploadRepository,
} from "@portal/db";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

type Repository = ReturnType<typeof createChangeOrderRepository>;
type Revision = NonNullable<Awaited<ReturnType<Repository["getRevision"]>>>;
type SafeRevision = Omit<Revision, "authoredByUserId" | "terms"> & {
  readonly terms: Omit<ChangeOrderTerms, "externalPdfMediaAssetId"> & {
    readonly externalPdfDownloadPath: string | null;
  };
};
type Detail = NonNullable<Awaited<ReturnType<Repository["getChangeOrder"]>>>;
type SafeDetail = Omit<Detail, "createdByUserId" | "revisions" | "actions"> & {
  readonly revisions: readonly SafeRevision[];
  readonly actions: readonly Omit<Detail["actions"][number], "actorUserId">[];
};
type Page = NonNullable<Awaited<ReturnType<Repository["listChangeOrders"]>>>;

export const CHANGE_ORDER_PATHS = Object.freeze({
  collection: "/v1/me/jobs/:jobId/change-orders",
  detail: "/v1/me/jobs/:jobId/change-orders/:changeOrderId",
  revisions: "/v1/me/jobs/:jobId/change-orders/:changeOrderId/revisions",
  revision:
    "/v1/me/jobs/:jobId/change-orders/:changeOrderId/revisions/:revisionId",
  replace: "/v1/me/jobs/:jobId/change-orders/:changeOrderId/replace",
  counterpropose:
    "/v1/me/jobs/:jobId/change-orders/:changeOrderId/counterpropose",
  propose: "/v1/me/jobs/:jobId/change-orders/:changeOrderId/propose",
  approve: "/v1/me/jobs/:jobId/change-orders/:changeOrderId/approve",
  reject: "/v1/me/jobs/:jobId/change-orders/:changeOrderId/reject",
  withdraw: "/v1/me/jobs/:jobId/change-orders/:changeOrderId/withdraw",
  pdfReservation: "/v1/me/jobs/:jobId/change-order-pdf-reservations",
  pdfUpload: "/v1/me/jobs/:jobId/change-order-revisions/:revisionId/pdf",
  pdfStatus:
    "/v1/me/jobs/:jobId/change-order-revisions/:revisionId/pdf/:mediaAssetId/status",
});

interface JobParams {
  readonly jobId: string;
}
interface DetailParams extends JobParams {
  readonly changeOrderId: string;
}
interface RevisionParams extends DetailParams {
  readonly revisionId: string;
}
interface ListQuery {
  readonly limit?: number;
  readonly afterCreatedAt?: string;
  readonly afterId?: string;
}
interface RevisionQuery {
  readonly limit?: number;
  readonly beforeRevisionNumber?: number;
}
interface CreateBody {
  readonly commandId: string;
  readonly revisionId: string;
  readonly terms: ChangeOrderTerms;
}
interface ReviseBody {
  readonly commandId: string;
  readonly expectedRevisionId: string;
  readonly terms: ChangeOrderTerms;
}
interface DecisionBody {
  readonly commandId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
}
interface PdfReservationBody {
  readonly commandId: string;
  readonly changeOrderId: string;
  readonly revisionId: string;
  readonly expectedRevisionId: string | null;
}

export interface ChangeOrderRouteDependencies {
  readonly pdfReservations?: Pick<
    ReturnType<typeof createChangeOrderPdfUploadRepository>,
    "reserve"
  > & {
    readStatus(input: {
      actorUserId: string;
      jobId: string;
      revisionId: string;
      mediaAssetId: string;
    }): Promise<{
      status: "PROCESSING" | "READY" | "REJECTED";
      expiresAt: Date;
      canCreateRevision: boolean;
    } | null>;
  };
  readonly documentUploads?: ChangeOrderDocumentUploadService;
  readonly changeOrders: {
    list(input: {
      actorUserId: string;
      jobId: string;
      limit: number;
      cursor?: { createdAt: string; changeOrderId: string } | null;
    }): Promise<{
      items: Page["items"];
      nextCursor: { createdAt: string; changeOrderId: string } | null;
    } | null>;
    get(input: {
      actorUserId: string;
      jobId: string;
      changeOrderId: string;
    }): Promise<SafeDetail | null>;
    listRevisions(input: {
      actorUserId: string;
      jobId: string;
      changeOrderId: string;
      limit: number;
      beforeRevisionNumber?: number;
    }): Promise<{
      items: readonly SafeRevision[];
      nextCursor: number | null;
    } | null>;
    getRevision(input: {
      actorUserId: string;
      jobId: string;
      changeOrderId: string;
      revisionId: string;
    }): Promise<SafeRevision | null>;
    create(
      input: RepositoryInput<"createDraft">,
    ): Promise<ChangeOrderCommandResult>;
    replace(
      input: RepositoryInput<"replaceDraft">,
    ): Promise<ChangeOrderCommandResult>;
    counterpropose(
      input: RepositoryInput<"counterpropose">,
    ): Promise<ChangeOrderCommandResult>;
    propose(
      input: RepositoryInput<"submitRevision">,
    ): Promise<ChangeOrderCommandResult>;
    approve(
      input: RepositoryInput<"approveRevision">,
    ): Promise<ChangeOrderCommandResult>;
    reject(
      input: RepositoryInput<"rejectRevision">,
    ): Promise<ChangeOrderCommandResult>;
    withdraw(
      input: RepositoryInput<"withdrawRevision">,
    ): Promise<ChangeOrderCommandResult>;
  };
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}
type RepositoryInput<K extends keyof Repository> = Repository[K] extends (
  input: infer I,
) => unknown
  ? I
  : never;

export function registerChangeOrderRoutes(
  app: FastifyInstance,
  dependencies: ChangeOrderRouteDependencies,
): void {
  registerPdfBodyParser(app);
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
  };
  const write = { ...common, onRequest: dependencies.csrfProtection };

  app.get<{ Params: JobParams; Querystring: ListQuery }>(
    CHANGE_ORDER_PATHS.collection,
    {
      ...common,
      preValidation: exactQuery(["limit", "afterCreatedAt", "afterId"]),
      schema: { params: jobParams, querystring: listQuery },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      if (
        (request.query.afterCreatedAt === undefined) !==
          (request.query.afterId === undefined) ||
        (request.query.afterCreatedAt !== undefined &&
          !validTimestamp(request.query.afterCreatedAt))
      )
        return reply.code(400).send({ code: "INVALID_CURSOR" });
      try {
        const page = await dependencies.changeOrders.list({
          actorUserId,
          jobId: request.params.jobId,
          limit: request.query.limit ?? 20,
          ...(request.query.afterCreatedAt === undefined
            ? {}
            : {
                cursor: {
                  createdAt: request.query.afterCreatedAt,
                  changeOrderId: request.query.afterId!,
                },
              }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              items: page.items.map((item) => ({
                ...item,
                createdAt: item.createdAt.toISOString(),
              })),
              nextCursor: page.nextCursor,
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: DetailParams }>(
    CHANGE_ORDER_PATHS.detail,
    {
      ...common,
      preValidation: exactQuery([]),
      schema: { params: detailParams },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const detail = await dependencies.changeOrders.get({
          actorUserId,
          ...request.params,
        });
        return detail === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              ...detail,
              createdAt: detail.createdAt.toISOString(),
              revisions: detail.revisions.map(serializeRevision),
              actions: detail.actions.map((action) => ({
                ...action,
                occurredAt: action.occurredAt.toISOString(),
              })),
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: DetailParams; Querystring: RevisionQuery }>(
    CHANGE_ORDER_PATHS.revisions,
    {
      ...common,
      preValidation: exactQuery(["limit", "beforeRevisionNumber"]),
      schema: { params: detailParams, querystring: revisionQuery },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const page = await dependencies.changeOrders.listRevisions({
          actorUserId,
          ...request.params,
          limit: request.query.limit ?? 20,
          ...(request.query.beforeRevisionNumber === undefined
            ? {}
            : { beforeRevisionNumber: request.query.beforeRevisionNumber }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              items: page.items.map(serializeRevision),
              nextCursor: page.nextCursor,
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: RevisionParams }>(
    CHANGE_ORDER_PATHS.revision,
    {
      ...common,
      preValidation: exactQuery([]),
      schema: { params: revisionParams },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const revision = await dependencies.changeOrders.getRevision({
          actorUserId,
          ...request.params,
        });
        return revision === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeRevision(revision));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: JobParams; Body: CreateBody }>(
    CHANGE_ORDER_PATHS.collection,
    {
      ...write,
      preValidation: exactBody(["commandId", "revisionId", "terms"], "create"),
      schema: { params: jobParams, body: createBody },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        return sendCommand(
          reply,
          await dependencies.changeOrders.create({
            actorUserId,
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

  for (const action of ["replace", "counterpropose"] as const) {
    app.post<{ Params: DetailParams; Body: ReviseBody }>(
      CHANGE_ORDER_PATHS[action],
      {
        ...write,
        preValidation: exactBody(
          ["commandId", "expectedRevisionId", "terms"],
          "revise",
        ),
        schema: { params: detailParams, body: reviseBody },
      },
      async (request, reply) => {
        const actorUserId = await actor(request, reply, dependencies);
        if (actorUserId === null) return;
        try {
          return sendCommand(
            reply,
            await dependencies.changeOrders[action]({
              actorUserId,
              ...request.params,
              ...request.body,
            }),
          );
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  for (const action of ["propose", "approve", "reject", "withdraw"] as const) {
    app.post<{ Params: DetailParams; Body: DecisionBody }>(
      CHANGE_ORDER_PATHS[action],
      {
        ...write,
        preValidation: exactBody(["commandId", "revisionId", "revisionNumber"]),
        schema: { params: detailParams, body: decisionBody },
      },
      async (request, reply) => {
        const actorUserId = await actor(request, reply, dependencies);
        if (actorUserId === null) return;
        try {
          return sendCommand(
            reply,
            await dependencies.changeOrders[action]({
              actorUserId,
              ...request.params,
              ...request.body,
            }),
          );
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  app.post<{ Params: JobParams; Body: PdfReservationBody }>(
    CHANGE_ORDER_PATHS.pdfReservation,
    {
      ...write,
      preValidation: exactBody([
        "commandId",
        "changeOrderId",
        "revisionId",
        "expectedRevisionId",
      ]),
      schema: { params: jobParams, body: pdfReservationBody },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      if (
        dependencies.documentUploads === undefined ||
        dependencies.pdfReservations === undefined
      )
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      try {
        const result = await dependencies.pdfReservations.reserve({
          actorUserId,
          jobId: request.params.jobId,
          ...request.body,
        });
        if (!("expiresAt" in result))
          return reply
            .code(result.status === "NOT_FOUND" ? 404 : 409)
            .send({ code: result.status });
        return reply
          .code(result.status === "AUTHORIZED" ? 201 : 200)
          .send({ ...result, expiresAt: result.expiresAt.toISOString() });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { jobId: string; revisionId: string }; Body: Buffer }>(
    CHANGE_ORDER_PATHS.pdfUpload,
    {
      ...write,
      bodyLimit: MEDIA_UPLOAD_LIMITS.documentMaxBytes,
      preValidation: exactQuery([]),
      schema: { params: uploadParams },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      if (dependencies.documentUploads === undefined)
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      if (
        !Buffer.isBuffer(request.body) ||
        request.body.byteLength < 1 ||
        request.headers["content-type"]?.trim().toLowerCase() !==
          "application/pdf"
      )
        return reply.code(400).send({ code: "INVALID_FILE" });
      try {
        const result = await dependencies.documentUploads.upload({
          actor: createAuthenticatedAuthorizationActor({
            accountState: "ACTIVE",
            id: actorUserId,
          }),
          body: request.body,
          declaredContentType: "application/pdf",
          jobId: request.params.jobId,
          revisionId: request.params.revisionId,
        });
        return result.status === "PROCESSING"
          ? reply.code(202).send(result)
          : reply.code(404).send({ code: "UPLOAD_UNAVAILABLE" });
      } catch (error) {
        if (error instanceof MediaUploadRejectedError)
          return reply.code(error.code === "FILE_TOO_LARGE" ? 413 : 400).send({
            code:
              error.code === "FILE_TOO_LARGE"
                ? "FILE_TOO_LARGE"
                : "INVALID_FILE",
          });
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      }
    },
  );

  app.get<{
    Params: { jobId: string; revisionId: string; mediaAssetId: string };
  }>(
    CHANGE_ORDER_PATHS.pdfStatus,
    {
      ...common,
      preValidation: exactQuery([]),
      schema: { params: pdfStatusParams },
    },
    async (request, reply) => {
      const actorUserId = await actor(request, reply, dependencies);
      if (actorUserId === null) return;
      if (dependencies.pdfReservations === undefined)
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      try {
        const result = await dependencies.pdfReservations.readStatus({
          actorUserId,
          ...request.params,
        });
        return result === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              status: result.status,
              expiresAt: result.expiresAt.toISOString(),
              canCreateRevision: result.canCreateRevision,
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function registerPdfBodyParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser("application/pdf")) return;
  app.addContentTypeParser(
    "application/pdf",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
}

function serializeRevision(revision: SafeRevision) {
  return {
    ...revision,
    createdAt: revision.createdAt.toISOString(),
    stateChangedAt: revision.stateChangedAt?.toISOString() ?? null,
  };
}
async function actor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ChangeOrderRouteDependencies,
): Promise<UserId | null> {
  const result = await dependencies.guard.evaluate(request);
  if (result.status === "ACTIVE") return result.user.id;
  void reply
    .code(result.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: result.status });
  return null;
}
function sendCommand(
  reply: FastifyReply,
  result: ChangeOrderCommandResult,
  created = false,
) {
  if (!("occurredAt" in result))
    return reply
      .code(result.status === "NOT_FOUND" ? 404 : 409)
      .send({ code: result.status });
  return reply
    .code(created && result.status === "APPLIED" ? 201 : 200)
    .send({ ...result, occurredAt: result.occurredAt.toISOString() });
}
function sendError(reply: FastifyReply, error: unknown) {
  return reply
    .code(
      error instanceof TypeError
        ? 400
        : error instanceof ChangeOrderIdempotencyError
          ? 409
          : 503,
    )
    .send({
      code:
        error instanceof TypeError
          ? "INVALID_REQUEST"
          : error instanceof ChangeOrderIdempotencyError
            ? "IDEMPOTENCY_CONFLICT"
            : "TEMPORARILY_UNAVAILABLE",
    });
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
function validTimestamp(value: string) {
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
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
function exactBody(keys: readonly string[], kind?: "create" | "revise") {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const value = request.body;
    if (!isExactObject(value, keys) || (kind && !validTerms(value.terms))) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}
function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function validTerms(value: unknown): boolean {
  if (
    !isExactOptionalObject(
      value,
      [
        "title",
        "reason",
        "changeDescription",
        "scopeAdded",
        "scopeRemoved",
        "scopeChanged",
        "priceImpact",
        "scheduleImpact",
      ],
      [
        "materialResponsibility",
        "warrantyChange",
        "otherConditionChange",
        "affectedMilestoneIds",
        "externalPdfMediaAssetId",
      ],
    )
  )
    return false;
  const price = value.priceImpact;
  const schedule = value.scheduleImpact;
  return (
    ((isExactObject(price, ["mode"]) && price.mode === "NONE") ||
      (isExactObject(price, ["mode", "amountCents", "vatStatus"]) &&
        price.mode === "FIXED_DELTA") ||
      (isExactObject(price, ["mode", "amountCents", "basis", "vatStatus"]) &&
        price.mode === "ESTIMATE_DELTA") ||
      (isExactObject(price, [
        "mode",
        "minimumCents",
        "maximumCents",
        "basis",
        "vatStatus",
      ]) &&
        price.mode === "RANGE_DELTA")) &&
    ((isExactObject(schedule, ["mode"]) && schedule.mode === "NONE") ||
      (isExactObject(schedule, ["mode", "deltaDays"]) &&
        schedule.mode === "DAYS") ||
      (isExactObject(schedule, ["mode", "newDate"]) &&
        schedule.mode === "DATE") ||
      (isExactObject(schedule, ["mode", "startDate", "endDate"]) &&
        schedule.mode === "RANGE"))
  );
}
function isExactOptionalObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const text = (maximum: number) => ({
  type: "string",
  minLength: 1,
  maxLength: maximum,
});
const stringArray = { type: "array", maxItems: 50, items: text(500) } as const;
const optionalText = (maximum: number) => ({
  anyOf: [text(maximum), { type: "null" }],
});
const optionalUuid = { anyOf: [uuid, { type: "null" }] } as const;
const cents = {
  type: "integer",
  minimum: -1_000_000_000_000,
  maximum: 1_000_000_000_000,
} as const;
const vatStatus = {
  type: "string",
  enum: ["VAT_INCLUDED", "VAT_EXCLUDED", "NOT_VAT_REGISTERED"],
} as const;
const date = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;
const priceImpact = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["NONE", "FIXED_DELTA", "ESTIMATE_DELTA", "RANGE_DELTA"],
    },
    amountCents: cents,
    minimumCents: cents,
    maximumCents: cents,
    basis: text(500),
    vatStatus,
  },
} as const;
const scheduleImpact = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["NONE", "DAYS", "DATE", "RANGE"] },
    deltaDays: { type: "integer", minimum: -3650, maximum: 3650 },
    newDate: date,
    startDate: date,
    endDate: date,
  },
} as const;
const terms = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "reason",
    "changeDescription",
    "scopeAdded",
    "scopeRemoved",
    "scopeChanged",
    "priceImpact",
    "scheduleImpact",
  ],
  properties: {
    title: text(160),
    reason: text(500),
    changeDescription: text(4000),
    scopeAdded: stringArray,
    scopeRemoved: stringArray,
    scopeChanged: stringArray,
    priceImpact,
    scheduleImpact,
    materialResponsibility: {
      anyOf: [
        { type: "string", enum: ["PROVIDER", "CUSTOMER", "MIXED"] },
        { type: "null" },
      ],
    },
    warrantyChange: optionalText(1000),
    otherConditionChange: optionalText(1000),
    affectedMilestoneIds: { type: "array", maxItems: 50, items: uuid },
    externalPdfMediaAssetId: optionalUuid,
  },
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
  required: ["jobId", "changeOrderId"],
  properties: { jobId: uuid, changeOrderId: uuid },
} as const;
const revisionParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "changeOrderId", "revisionId"],
  properties: { jobId: uuid, changeOrderId: uuid, revisionId: uuid },
} as const;
const uploadParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "revisionId"],
  properties: { jobId: uuid, revisionId: uuid },
} as const;
const pdfStatusParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "revisionId", "mediaAssetId"],
  properties: { jobId: uuid, revisionId: uuid, mediaAssetId: uuid },
} as const;
const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 20 },
    afterCreatedAt: { type: "string", maxLength: 40 },
    afterId: uuid,
  },
} as const;
const revisionQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 20 },
    beforeRevisionNumber: { type: "integer", minimum: 1, maximum: 2147483647 },
  },
} as const;
const createBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "revisionId", "terms"],
  properties: { commandId: uuid, revisionId: uuid, terms },
} as const;
const reviseBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "expectedRevisionId", "terms"],
  properties: { commandId: uuid, expectedRevisionId: uuid, terms },
} as const;
const decisionBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "revisionId", "revisionNumber"],
  properties: {
    commandId: uuid,
    revisionId: uuid,
    revisionNumber: { type: "integer", minimum: 1, maximum: 2147483647 },
  },
} as const;
const pdfReservationBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "changeOrderId", "revisionId", "expectedRevisionId"],
  properties: {
    commandId: uuid,
    changeOrderId: uuid,
    revisionId: uuid,
    expectedRevisionId: optionalUuid,
  },
} as const;
