import {
  ExternalPdfQuoteIdempotencyError,
  normalizeSaveExternalPdfQuoteDraftInput,
  QuoteIdempotencyError,
  StructuredQuoteIdempotencyError,
  type ConversationId,
  type ExternalPdfQuoteEnvelopeInput,
  type ExternalPdfQuotePersistence,
  type ExternalPdfQuoteRevision,
  type JobInvitationId,
  type Quote,
  type QuoteId,
  type QuotePersistence,
  type StructuredQuoteContentRevision,
  type StructuredQuoteDraftContentInput,
  type StructuredQuotePersistence,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const QUOTE_AUTHORING_PATHS = Object.freeze({
  byInvitation: "/v1/me/invitations/:invitationId/quote",
  create: "/v1/me/conversations/:conversationId/quotes",
  external: "/v1/me/quotes/:quoteId/revisions/:quoteRevision/external-pdf",
  quote: "/v1/me/quotes/:quoteId",
  reject: "/v1/me/quotes/:quoteId/revisions/:quoteRevision/reject",
  revision: "/v1/me/quotes/:quoteId/revisions",
  structured: "/v1/me/quotes/:quoteId/revisions/:quoteRevision/structured",
  submit: "/v1/me/quotes/:quoteId/revisions/:quoteRevision/submit",
} as const);

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface QuoteAuthoringRouteDependencies {
  readonly core: QuotePersistence;
  readonly csrfProtection: onRequestHookHandler;
  readonly externalPdf: ExternalPdfQuotePersistence;
  readonly guard: Guard;
  readonly structured: StructuredQuotePersistence;
}

type StructuredHttpContent = Omit<
  StructuredQuoteDraftContentInput,
  "validUntil"
> & { readonly validUntil?: string | null };
type ExternalPdfHttpEnvelope = Omit<
  ExternalPdfQuoteEnvelopeInput,
  "validUntil"
> & { readonly validUntil?: string | null };

export function registerQuoteAuthoringRoutes(
  app: FastifyInstance,
  dependencies: QuoteAuthoringRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (
      request.url.startsWith("/v1/me/quotes/") ||
      request.url.startsWith("/v1/me/conversations/") ||
      request.url.startsWith("/v1/me/invitations/")
    ) {
      void reply.header("cache-control", "private, no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get<{ Params: { readonly invitationId: string } }>(
    QUOTE_AUTHORING_PATHS.byInvitation,
    { schema: { params: invitationParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      return readQuote(reply, () =>
        dependencies.core.readOwnedByInvitation({
          actorUserId,
          invitationId: request.params.invitationId as JobInvitationId,
        }),
      );
    },
  );

  app.get<{ Params: { readonly quoteId: string } }>(
    QUOTE_AUTHORING_PATHS.quote,
    { schema: { params: quoteParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      return readQuote(reply, () =>
        dependencies.core.readOwned({
          actorUserId,
          quoteId: request.params.quoteId as QuoteId,
        }),
      );
    },
  );

  app.post<{
    Body: {
      readonly authoringMode: "EXTERNAL_PDF" | "PLATFORM_STRUCTURED";
      readonly commandId: string;
      readonly requestContentRevision: number;
      readonly requestVisibleVersion: number;
    };
    Params: { readonly conversationId: string };
  }>(
    QUOTE_AUTHORING_PATHS.create,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: createSchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.core.createDraft({
          actorUserId,
          authoringMode: request.body.authoringMode,
          commandId: request.body.commandId,
          conversationId: request.params.conversationId as ConversationId,
          requestContentRevision: request.body.requestContentRevision,
          requestVisibleVersion: request.body.requestVisibleVersion,
        });
        return sendCoreResult(reply, result, 201);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      readonly authoringMode: "EXTERNAL_PDF" | "PLATFORM_STRUCTURED";
      readonly commandId: string;
      readonly expectedSubmittedStateRevision: number;
      readonly requestContentRevision: number;
      readonly requestVisibleVersion: number;
    };
    Params: { readonly quoteId: string };
  }>(
    QUOTE_AUTHORING_PATHS.revision,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: createRevisionSchema, params: quoteParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.core.createRevision({
          actorUserId,
          authoringMode: request.body.authoringMode,
          commandId: request.body.commandId,
          expectedSubmittedStateRevision:
            request.body.expectedSubmittedStateRevision,
          quoteId: request.params.quoteId as QuoteId,
          requestContentRevision: request.body.requestContentRevision,
          requestVisibleVersion: request.body.requestVisibleVersion,
        });
        return sendCoreResult(reply, result, 201);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      readonly commandId: string;
      readonly expectedDraftStateRevision: number;
      readonly expectedSubmittedStateRevision: number | null;
    };
    Params: { readonly quoteId: string; readonly quoteRevision: number };
  }>(
    QUOTE_AUTHORING_PATHS.submit,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: submitSchema, params: revisionParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.core.submit({
          actorUserId,
          commandId: request.body.commandId,
          expectedDraftStateRevision: request.body.expectedDraftStateRevision,
          expectedSubmittedStateRevision:
            request.body.expectedSubmittedStateRevision,
          quoteId: request.params.quoteId as QuoteId,
          revision: request.params.quoteRevision,
        });
        return sendCoreResult(reply, result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      readonly commandId: string;
      readonly expectedStateRevision: number;
      readonly rejectionReason?: string | null;
    };
    Params: { readonly quoteId: string; readonly quoteRevision: number };
  }>(
    QUOTE_AUTHORING_PATHS.reject,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: rejectSchema, params: revisionParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.core.reject({
          actorUserId,
          commandId: request.body.commandId,
          expectedStateRevision: request.body.expectedStateRevision,
          quoteId: request.params.quoteId as QuoteId,
          ...(request.body.rejectionReason === undefined
            ? {}
            : { rejectionReason: request.body.rejectionReason }),
          revision: request.params.quoteRevision,
        });
        return sendCoreResult(reply, result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  registerStructuredRoutes(app, dependencies);
  registerExternalPdfRoutes(app, dependencies);
}

function registerStructuredRoutes(
  app: FastifyInstance,
  dependencies: QuoteAuthoringRouteDependencies,
): void {
  app.get<{
    Params: { readonly quoteId: string; readonly quoteRevision: number };
  }>(
    QUOTE_AUTHORING_PATHS.structured,
    { schema: { params: revisionParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const content = await dependencies.structured.readOwned({
          actorUserId,
          quoteId: request.params.quoteId as QuoteId,
          quoteRevision: request.params.quoteRevision,
        });
        return content === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeStructured(content));
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
  app.post<{
    Body: {
      readonly commandId: string;
      readonly content: StructuredHttpContent;
      readonly expectedContentRevision: number;
    };
    Params: { readonly quoteId: string; readonly quoteRevision: number };
  }>(
    QUOTE_AUTHORING_PATHS.structured,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: structuredSaveSchema, params: revisionParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.structured.saveDraft({
          actorUserId,
          commandId: request.body.commandId,
          content: parseStructuredContent(request.body.content),
          expectedContentRevision: request.body.expectedContentRevision,
          quoteId: request.params.quoteId as QuoteId,
          quoteRevision: request.params.quoteRevision,
        });
        if ("content" in result)
          return reply.send({
            content: serializeStructured(result.content),
            status: result.status,
          });
        return sendFailure(reply, result.status, {
          currentContentRevision: result.currentContentRevision,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function registerExternalPdfRoutes(
  app: FastifyInstance,
  dependencies: QuoteAuthoringRouteDependencies,
): void {
  app.get<{
    Params: { readonly quoteId: string; readonly quoteRevision: number };
  }>(
    QUOTE_AUTHORING_PATHS.external,
    { schema: { params: revisionParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const revision = await dependencies.externalPdf.readOwned({
          actorUserId,
          quoteId: request.params.quoteId as QuoteId,
          quoteRevision: request.params.quoteRevision,
        });
        return revision === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeExternal(revision));
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
  app.post<{
    Body: {
      readonly commandId: string;
      readonly envelope: ExternalPdfHttpEnvelope;
      readonly expectedContentRevision: number;
      readonly pdfAssetId: string;
    };
    Params: { readonly quoteId: string; readonly quoteRevision: number };
  }>(
    QUOTE_AUTHORING_PATHS.external,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: externalSaveSchema, params: revisionParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const { validUntil, ...envelope } = request.body.envelope;
        const command = normalizeSaveExternalPdfQuoteDraftInput({
          actorUserId,
          commandId: request.body.commandId,
          envelope: {
            ...envelope,
            ...optionalDateProperty(validUntil),
          },
          expectedContentRevision: request.body.expectedContentRevision,
          pdfAssetId: request.body.pdfAssetId,
          quoteId: request.params.quoteId as QuoteId,
          quoteRevision: request.params.quoteRevision,
        });
        const result = await dependencies.externalPdf.saveDraft(command);
        if ("revision" in result)
          return reply.send({
            revision: serializeExternal(result.revision),
            status: result.status,
          });
        return sendFailure(reply, result.status);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

async function readQuote(
  reply: FastifyReply,
  read: () => Promise<Quote | null>,
) {
  try {
    const quote = await read();
    return quote === null
      ? reply.code(404).send({ code: "NOT_FOUND" })
      : reply.send(serializeQuote(quote));
  } catch {
    return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
  }
}

function sendCoreResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<QuotePersistence["createDraft"]>>,
  appliedStatus = 200,
) {
  if ("quote" in result)
    return reply.code(result.status === "APPLIED" ? appliedStatus : 200).send({
      quote: serializeQuote(result.quote),
      status: result.status,
    });
  return sendFailure(reply, result.status, {
    currentDraftStateRevision: result.currentDraftStateRevision,
    currentSubmittedStateRevision: result.currentSubmittedStateRevision,
  });
}

function sendFailure(
  reply: FastifyReply,
  status: string,
  metadata: Readonly<Record<string, number | null | undefined>> = {},
) {
  if (status === "NOT_FOUND") return reply.code(404).send({ code: status });
  if (
    status === "AUTHORING_NOT_READY" ||
    status === "INVALID_TRANSITION" ||
    status === "PDF_NOT_READY" ||
    status === "READ_ONLY" ||
    status === "STALE_REVISION"
  )
    return reply.code(409).send({
      code: status,
      ...Object.fromEntries(
        Object.entries(metadata).filter((entry) => entry[1] !== undefined),
      ),
    });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (
    error instanceof QuoteIdempotencyError ||
    error instanceof StructuredQuoteIdempotencyError ||
    error instanceof ExternalPdfQuoteIdempotencyError
  )
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "ACTIVE") return result.user.id;
  await reply
    .code(result.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: result.status });
  return undefined;
}

function serializeQuote(quote: Quote) {
  return {
    conversationId: quote.conversationId,
    createdAt: quote.createdAt.toISOString(),
    currentDraft:
      quote.currentDraft === null
        ? null
        : serializeRevision(quote.currentDraft),
    currentSubmitted:
      quote.currentSubmitted === null
        ? null
        : serializeRevision(quote.currentSubmitted),
    id: quote.id,
    invitationId: quote.invitationId,
    jobRequestId: quote.jobRequestId,
    participantRole: quote.participantRole,
    revisions: quote.revisions.map(serializeRevision),
  };
}

function serializeRevision(revision: Quote["revisions"][number]) {
  return {
    authoringMode: revision.authoringMode,
    changedAt: revision.changedAt.toISOString(),
    createdAt: revision.createdAt.toISOString(),
    rejectionReason: revision.rejectionReason,
    requestContentRevision: revision.requestContentRevision,
    requestVisibleVersion: revision.requestVisibleVersion,
    revision: revision.revision,
    state: revision.state,
    stateRevision: revision.stateRevision,
    submittedAt: revision.submittedAt?.toISOString() ?? null,
  };
}

function serializeStructured(content: StructuredQuoteContentRevision) {
  return {
    ...content,
    changedAt: content.changedAt.toISOString(),
    validUntil: content.validUntil?.toISOString() ?? null,
  };
}

function serializeExternal(revision: ExternalPdfQuoteRevision) {
  return {
    ...revision,
    confirmedAt: revision.confirmedAt.toISOString(),
    savedAt: revision.savedAt.toISOString(),
    validUntil: revision.validUntil?.toISOString() ?? null,
  };
}

function parseStructuredContent(
  content: StructuredHttpContent,
): StructuredQuoteDraftContentInput {
  const { validUntil, ...withoutValidUntil } = content;
  return {
    ...withoutValidUntil,
    ...optionalDateProperty(validUntil),
  };
}

function optionalDateProperty(value: unknown): {
  readonly validUntil?: Date | null;
} {
  const validUntil = optionalDate(value);
  return validUntil === undefined ? {} : { validUntil };
}

function optionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("invalid validUntil");
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value)
    throw new TypeError("invalid validUntil");
  return date;
}

const uuid = { format: "uuid", type: "string" } as const;
const positiveInteger = { minimum: 1, type: "integer" } as const;
const nullablePositiveInteger = {
  anyOf: [positiveInteger, { type: "null" }],
} as const;
const quoteParamsSchema = object({ quoteId: uuid }, ["quoteId"]);
const invitationParamsSchema = object({ invitationId: uuid }, ["invitationId"]);
const conversationParamsSchema = object({ conversationId: uuid }, [
  "conversationId",
]);
const revisionParamsSchema = object(
  { quoteId: uuid, quoteRevision: positiveInteger },
  ["quoteId", "quoteRevision"],
);
const authoringMode = {
  enum: ["PLATFORM_STRUCTURED", "EXTERNAL_PDF"],
  type: "string",
} as const;
const createSchema = object(
  {
    authoringMode,
    commandId: uuid,
    requestContentRevision: positiveInteger,
    requestVisibleVersion: positiveInteger,
  },
  [
    "authoringMode",
    "commandId",
    "requestContentRevision",
    "requestVisibleVersion",
  ],
);
const createRevisionSchema = object(
  {
    ...createSchema.properties,
    expectedSubmittedStateRevision: positiveInteger,
  },
  [...createSchema.required, "expectedSubmittedStateRevision"],
);
const submitSchema = object(
  {
    commandId: uuid,
    expectedDraftStateRevision: positiveInteger,
    expectedSubmittedStateRevision: nullablePositiveInteger,
  },
  ["commandId", "expectedDraftStateRevision", "expectedSubmittedStateRevision"],
);
const rejectSchema = object(
  {
    commandId: uuid,
    expectedStateRevision: positiveInteger,
    rejectionReason: {
      anyOf: [
        { maxLength: 500, minLength: 1, type: "string" },
        { type: "null" },
      ],
    },
  },
  ["commandId", "expectedStateRevision"],
);
const nullableAmount = {
  anyOf: [
    { maximum: 1_000_000_000_000, minimum: 1, type: "integer" },
    { type: "null" },
  ],
} as const;
const nullableText = {
  anyOf: [{ maxLength: 2_000, type: "string" }, { type: "null" }],
} as const;
const componentSchema = object(
  { amountCents: nullableAmount, description: nullableText },
  [],
);
const structuredContentSchema = object(
  {
    components: object(
      {
        labor: componentSchema,
        material: componentSchema,
        other: componentSchema,
        transport: componentSchema,
      },
      [],
    ),
    conditionalOnInspection: { type: "boolean" },
    currency: { const: "EUR", type: "string" },
    depositAmountCents: nullableAmount,
    depositMode: {
      anyOf: [
        { enum: ["NONE", "FIXED_AMOUNT", "PERCENTAGE"], type: "string" },
        { type: "null" },
      ],
    },
    depositNotes: nullableText,
    depositPercentageBasisPoints: {
      anyOf: [
        { maximum: 10_000, minimum: 1, type: "integer" },
        { type: "null" },
      ],
    },
    estimatedDurationDays: {
      anyOf: [
        { maximum: 3_650, minimum: 1, type: "integer" },
        { type: "null" },
      ],
    },
    estimatedStartOn: {
      anyOf: [
        { pattern: "^\\d{4}-\\d{2}-\\d{2}$", type: "string" },
        { type: "null" },
      ],
    },
    excludedScope: {
      items: { maxLength: 500, type: "string" },
      maxItems: 20,
      type: "array",
    },
    includedScope: {
      items: { maxLength: 500, type: "string" },
      maxItems: 20,
      type: "array",
    },
    inspectionConditions: nullableText,
    materialResponsibility: {
      enum: ["PROVIDER", "CUSTOMER", "MIXED"],
      type: "string",
    },
    priceBasis: { maxLength: 2_000, minLength: 1, type: "string" },
    priceMode: { enum: ["FIXED", "ESTIMATE", "RANGE"], type: "string" },
    providerNotes: nullableText,
    rangeMaximumCents: nullableAmount,
    rangeMinimumCents: nullableAmount,
    summary: { maxLength: 2_000, minLength: 1, type: "string" },
    title: { maxLength: 200, minLength: 1, type: "string" },
    totalAmountCents: nullableAmount,
    validUntil: {
      anyOf: [{ format: "date-time", type: "string" }, { type: "null" }],
    },
    vatStatus: {
      enum: ["VAT_INCLUDED", "VAT_EXCLUDED", "NOT_VAT_REGISTERED"],
      type: "string",
    },
    warrantyInformation: nullableText,
  },
  [
    "components",
    "conditionalOnInspection",
    "currency",
    "materialResponsibility",
    "priceBasis",
    "priceMode",
    "summary",
    "title",
    "vatStatus",
  ],
);
const structuredSaveSchema = object(
  {
    commandId: uuid,
    content: structuredContentSchema,
    expectedContentRevision: { minimum: 0, type: "integer" },
  },
  ["commandId", "content", "expectedContentRevision"],
);
const externalEnvelopeSchema = object(
  {
    currency: { const: "EUR", type: "string" },
    depositAmountCents: nullableAmount,
    depositMode: structuredContentSchema.properties.depositMode,
    depositPercentageBasisPoints:
      structuredContentSchema.properties.depositPercentageBasisPoints,
    estimatedDurationDays:
      structuredContentSchema.properties.estimatedDurationDays,
    estimatedStartOn: structuredContentSchema.properties.estimatedStartOn,
    materialResponsibility: {
      anyOf: [
        structuredContentSchema.properties.materialResponsibility,
        { type: "null" },
      ],
    },
    priceMode: structuredContentSchema.properties.priceMode,
    providerConfirmedSummaryMatchesPdf: { const: true, type: "boolean" },
    rangeMaximumCents: nullableAmount,
    rangeMinimumCents: nullableAmount,
    totalAmountCents: nullableAmount,
    validUntil: structuredContentSchema.properties.validUntil,
    vatStatus: structuredContentSchema.properties.vatStatus,
  },
  ["currency", "priceMode", "providerConfirmedSummaryMatchesPdf", "vatStatus"],
);
const externalSaveSchema = object(
  {
    commandId: uuid,
    envelope: externalEnvelopeSchema,
    expectedContentRevision: { minimum: 0, type: "integer" },
    pdfAssetId: uuid,
  },
  ["commandId", "envelope", "expectedContentRevision", "pdfAssetId"],
);

function object<
  Properties extends Readonly<Record<string, unknown>>,
  Required extends readonly string[],
>(properties: Properties, required: Required) {
  return {
    additionalProperties: false,
    properties,
    required,
    type: "object",
  } as const;
}
