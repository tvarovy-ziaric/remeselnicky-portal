import {
  JobLocationIdempotencyError,
  type ClarifyJobLocationInput,
  type ClarifyJobLocationResult,
  type JobContactDetails,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_CONTACTS_PATH = "/v1/me/jobs/:jobId/contacts" as const;
export const JOB_LOCATION_CLARIFICATION_PATH =
  "/v1/me/jobs/:jobId/location/clarify" as const;

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobContactRouteDependencies {
  readonly contacts: {
    readForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
    }): Promise<JobContactDetails | null>;
  };
  readonly clarifications: {
    clarify(input: ClarifyJobLocationInput): Promise<ClarifyJobLocationResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobContactRoutes(
  app: FastifyInstance,
  dependencies: JobContactRouteDependencies,
): void {
  app.get<{ Params: { jobId: string } }>(
    JOB_CONTACTS_PATH,
    {
      config: {
        rateLimit: rateLimit(dependencies),
      },
      onSend: privateHeaders,
      schema: { params: paramsSchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") {
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      }
      try {
        const details = await dependencies.contacts.readForPrimaryParty({
          actorUserId: actor.user.id,
          jobId: request.params.jobId,
        });
        return details === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(details);
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
  app.post<{
    Body: Omit<ClarifyJobLocationInput, "actorUserId" | "jobId">;
    Params: { jobId: string };
  }>(
    JOB_LOCATION_CLARIFICATION_PATH,
    {
      config: { rateLimit: rateLimit(dependencies) },
      onRequest: dependencies.csrfProtection,
      onSend: privateHeaders,
      preValidation: rejectUnexpectedFields,
      schema: { body: clarificationBodySchema, params: paramsSchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE")
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      try {
        const result = await dependencies.clarifications.clarify({
          actorUserId: actor.user.id,
          commandId: request.body.commandId,
          expectedRevision: request.body.expectedRevision,
          jobId: request.params.jobId,
          location: request.body.location,
          reason: request.body.reason,
        });
        if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            recordedAt: result.recordedAt.toISOString(),
            revision: result.revision,
            status: result.status,
          });
        return reply
          .code(result.status === "NOT_FOUND" ? 404 : 409)
          .send({ code: result.status });
      } catch (error) {
        if (error instanceof JobLocationIdempotencyError)
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        if (error instanceof TypeError)
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

function rateLimit(dependencies: JobContactRouteDependencies) {
  return {
    max: dependencies.rateLimit.max,
    timeWindow: dependencies.rateLimit.timeWindowMs,
  };
}

function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}

function rejectUnexpectedFields(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    !exactKeys(body, ["commandId", "expectedRevision", "location", "reason"]) ||
    !exactKeys((body as Record<string, unknown>)["location"], [
      "exactAddress",
      "mapPin",
      "municipalityCode",
      "textClarification",
    ])
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  const pin = (
    (body as Record<string, unknown>)["location"] as Record<string, unknown>
  )["mapPin"];
  if (pin !== null && !exactKeys(pin, ["latitude", "longitude"])) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

const uuidSchema = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { jobId: uuidSchema },
  required: ["jobId"],
  type: "object",
} as const;
const clarificationBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    expectedRevision: { minimum: 1, type: "integer" },
    location: {
      additionalProperties: false,
      properties: {
        exactAddress: {
          anyOf: [
            { maxLength: 500, minLength: 1, type: "string" },
            { type: "null" },
          ],
        },
        mapPin: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                latitude: { maximum: 90, minimum: -90, type: "number" },
                longitude: { maximum: 180, minimum: -180, type: "number" },
              },
              required: ["latitude", "longitude"],
              type: "object",
            },
            { type: "null" },
          ],
        },
        municipalityCode: { minLength: 1, type: "string" },
        textClarification: {
          anyOf: [
            { maxLength: 1000, minLength: 1, type: "string" },
            { type: "null" },
          ],
        },
      },
      required: [
        "exactAddress",
        "mapPin",
        "municipalityCode",
        "textClarification",
      ],
      type: "object",
    },
    reason: { maxLength: 500, minLength: 8, type: "string" },
  },
  required: ["commandId", "expectedRevision", "location", "reason"],
  type: "object",
} as const;
