import { randomUUID } from "node:crypto";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  getJobSupervisorEvaluationNotificationCopy,
  mapDemandSideNotificationEvent,
  mapJobSupervisorEvaluationNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

const evaluationId = randomUUID();
const jobId = randomUUID();
const recipientUserId = randomUUID();

function event(
  payload: Readonly<Record<string, boolean | number | string | null>> = {},
  entityId = evaluationId,
): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: entityId, type: "SUPERVISOR_EVALUATION" }),
    eventId: randomUUID(),
    idempotencyKey: `supervisor-evaluation:${randomUUID()}`,
    name: "job.review.supervisor.visible",
    occurredAt: new Date("2026-09-24T08:00:00.000Z"),
    payload: Object.freeze({
      evaluation_id: evaluationId,
      job_id: jobId,
      recipient_user_id: recipientUserId,
      ...payload,
    }),
    schemaVersion: 1,
  });
}

describe("supervisor evaluation notification catalog", () => {
  it("creates one private in-app read action without raw evaluation content", () => {
    const draft = mapDemandSideNotificationEvent(event())?.[0];
    expect(draft).toEqual({
      channels: ["IN_APP"],
      context: {
        entityId: evaluationId,
        entityType: "SUPERVISOR_EVALUATION",
        path: `/zakazky/${jobId}/hodnotenia/odborne/${evaluationId}`,
      },
      payload: {
        action: "READ_SUPERVISOR_EVALUATION",
        evaluation_id: evaluationId,
        job_id: jobId,
      },
      priority: "INFO",
      recipientUserId,
      type: "job.review.supervisor.visible",
    });
    expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    expect(JSON.stringify(draft)).not.toMatch(
      /rating|comment|address|email|phone|evaluator/iu,
    );
  });

  it("fails closed on extra private fields and incoherent identities", () => {
    expect(() =>
      mapJobSupervisorEvaluationNotificationEvent(
        event({ comment: "never copy me" }),
      ),
    ).toThrow(/payload keys/iu);
    expect(() =>
      mapJobSupervisorEvaluationNotificationEvent(event({}, randomUUID())),
    ).toThrow(/identity/iu);
    expect(() =>
      mapJobSupervisorEvaluationNotificationEvent({
        ...event(),
        schemaVersion: 2,
      }),
    ).toThrow(/envelope/iu);
  });

  it("keeps neutral Slovak copy separate from private event data", () => {
    const copy = getJobSupervisorEvaluationNotificationCopy(
      "job.review.supervisor.visible",
    );
    expect(copy.title).toBe("Nové technické hodnotenie");
    expect(copy.body).toMatch(/pozrieť/iu);
    expect(`${copy.title} ${copy.body}`).not.toMatch(/päť|5.?hviezd|pozitív/iu);
  });

  it("ignores events outside its bounded catalog", () => {
    expect(
      mapJobSupervisorEvaluationNotificationEvent({
        ...event(),
        name: "job.review.other",
      }),
    ).toBeUndefined();
  });
});
