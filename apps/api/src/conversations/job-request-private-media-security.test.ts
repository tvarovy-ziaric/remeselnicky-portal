import {
  createJobRequestMediaAccessResolver,
  createPrivateMediaDeliveryRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import {
  createPrivateMediaDeliveryService,
  createPurposeBoundMediaEntityAccessResolver,
} from "@portal/media";
import type { ObjectStorageService } from "@portal/storage";
import Fastify from "fastify";
import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONVERSATION_PATHS, registerConversationRoutes } from "./routes.js";

const ownerId = userId(1);
const invitedProviderId = userId(2);
const competitorId = userId(3);
const unrelatedCustomerId = userId(4);
const unrelatedProviderId = userId(5);
const adminRoleOnlyId = userId(6);
const suspendedProviderId = userId(7);
const jobRequestId = uuid(20);
const invitationId = uuid(21);
const jobRequestAssetId = uuid(30);
const unknownAssetId = uuid(31);
const wrongKindAssetId = uuid(32);
const fixedNow = new Date("2026-09-28T08:00:00.000Z");
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("JobRequest private-media API authorization seam", () => {
  it("permits only the owner and entitled provider across UUID substitutions", async () => {
    const sqlFixture = securitySql();
    const sql = sqlFixture.sql;
    const createPrivateDownload = vi.fn(() =>
      Promise.resolve({
        expiresAt: new Date(fixedNow.valueOf() + 30_000),
        url: new URL("https://objects.example.test/private-grant?token=opaque"),
      }),
    );
    const storage: ObjectStorageService = {
      createPrivateDownload,
      readPrivateForProcessing: vi.fn(() =>
        Promise.reject(new Error("unused")),
      ),
      revokePublicDerivative: vi.fn(() => Promise.reject(new Error("unused"))),
      storePrivate: vi.fn(() => Promise.reject(new Error("unused"))),
      storePublicDerivative: vi.fn(() => Promise.reject(new Error("unused"))),
    };
    const privateMediaDelivery = createPrivateMediaDeliveryService({
      applicationOrigin: "https://portal.example.test",
      clock: () => fixedNow,
      entityAccess: createPurposeBoundMediaEntityAccessResolver({
        byPurpose: {
          JOB_REQUEST_DOCUMENT: createJobRequestMediaAccessResolver(sql),
          JOB_REQUEST_IMAGE: createJobRequestMediaAccessResolver(sql),
        },
      }),
      repository: createPrivateMediaDeliveryRepository(sql),
      storage,
    });
    const app = Fastify();
    openApps.push(app);
    const csrfProtection: onRequestHookHandler = (_request, _reply, done) => {
      done();
    };
    registerConversationRoutes(app, {
      chat: {
        csrfProtection,
        persistence: { readTimeline: vi.fn() },
        privateMediaDelivery,
        service: {
          report: vi.fn(),
          sendMessage: vi.fn(),
          updateParticipantState: vi.fn(),
        },
      },
      conversations: {
        readOwned: vi.fn(),
        readOwnedByInvitation: vi.fn(),
      },
      guard: {
        evaluate: (request) => {
          const actor = String(request.headers["x-test-actor"] ?? "");
          return Promise.resolve(
            actor === suspendedProviderId
              ? ({ status: "ACCOUNT_NOT_ACTIVE" } as const)
              : ({
                  status: "ACTIVE" as const,
                  user: { id: actor as UserId },
                } as const),
          );
        },
      },
    });

    const cases = [
      ["customer owner", ownerId, jobRequestAssetId, 303],
      ["entitled invited provider", invitedProviderId, jobRequestAssetId, 303],
      ["competitor", competitorId, jobRequestAssetId, 404],
      ["unrelated customer", unrelatedCustomerId, jobRequestAssetId, 404],
      ["unrelated provider", unrelatedProviderId, jobRequestAssetId, 404],
      ["role-only admin", adminRoleOnlyId, jobRequestAssetId, 404],
      [
        "suspended invited provider",
        suspendedProviderId,
        jobRequestAssetId,
        404,
      ],
      ["unknown UUID", ownerId, unknownAssetId, 404],
      ["wrong-kind UUID", invitedProviderId, wrongKindAssetId, 404],
    ] as const;

    for (const [label, actorUserId, mediaAssetId, expectedStatus] of cases) {
      const response = await app.inject({
        headers: { "x-test-actor": actorUserId },
        method: "GET",
        url: CONVERSATION_PATHS.mediaDownload.replace(
          ":mediaAssetId",
          mediaAssetId,
        ),
      });
      expect(response.statusCode, label).toBe(expectedStatus);
      expect(response.headers["cache-control"], label).toBe(
        "private, no-store",
      );
      expect(response.headers["x-content-type-options"], label).toBe("nosniff");
      expect(response.headers["x-robots-tag"], label).toBe("noindex, nofollow");
      if (expectedStatus === 303) {
        expect(response.headers.location, label).toBe(
          "https://objects.example.test/private-grant?token=opaque",
        );
        expect(response.body, label).toBe("");
      } else {
        expect(response.json(), label).toEqual({ code: "MEDIA_NOT_FOUND" });
        expect(response.body, label).not.toMatch(
          /bucket|content.?type|filename|location|object|storage|url/iu,
        );
        expect(response.headers.location, label).toBeUndefined();
      }
    }

    expect(createPrivateDownload).toHaveBeenCalledTimes(2);
    expect(sqlFixture.accessQueries).toBeGreaterThan(0);
    expect(sqlFixture.accessQueryText).not.toMatch(
      /storage_key|content_sha256/iu,
    );
  });
});

interface SecuritySql {
  readonly accessQueries: number;
  readonly accessQueryText: string;
  readonly sql: Parameters<typeof createPrivateMediaDeliveryRepository>[0];
}

function securitySql(): SecuritySql {
  let accessQueries = 0;
  let accessQueryText = "";
  const tagged = vi.fn(
    (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      const query = strings.join("?");
      if (query.includes('actor.id AS "actorUserId"')) {
        const mediaAssetId = String(values[0]);
        const actorUserId = String(values[1]);
        if (mediaAssetId === unknownAssetId) return Promise.resolve([]);
        const wrongKind = mediaAssetId === wrongKindAssetId;
        return Promise.resolve([
          {
            actorAccountState:
              actorUserId === suspendedProviderId ? "SUSPENDED" : "ACTIVE",
            actorUserId,
            assetId: mediaAssetId,
            assetStatus: "READY",
            assetUpdatedAt: fixedNow,
            contentType: "image/webp",
            objectCreatedAt: fixedNow,
            objectId: uuid(wrongKind ? 41 : 40),
            objectRevokedAt: null,
            ownerUserId: ownerId,
            provenanceEntityId: wrongKind ? uuid(22) : jobRequestId,
            provenanceEntityRevision: 7,
            provenanceEntityType: wrongKind
              ? "CONVERSATION_MESSAGE"
              : "JOB_REQUEST",
            purpose: wrongKind ? "CHAT_IMAGE" : "JOB_REQUEST_IMAGE",
            storageArea: "private",
            storageKey: `private/2026/09/${uuid(wrongKind ? 51 : 50)}`,
          },
        ]);
      }
      if (query.includes('access.grant AS "grant"')) {
        accessQueries += 1;
        accessQueryText = query;
        const actorUserId = values[1];
        if (actorUserId === ownerId) {
          return Promise.resolve([
            {
              contentRevision: 7,
              grant: "JOB_CUSTOMER",
              relationId: jobRequestId,
              relationRevision: 7,
            },
          ]);
        }
        if (actorUserId === invitedProviderId) {
          return Promise.resolve([
            {
              contentRevision: 7,
              grant: "INVITED_PROVIDER",
              relationId: invitationId,
              relationRevision: 2,
            },
          ]);
        }
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected SQL in JobRequest media seam: ${query}`);
    },
  );
  return {
    get accessQueries() {
      return accessQueries;
    },
    get accessQueryText() {
      return accessQueryText;
    },
    sql: tagged as never,
  };
}

function uuid(value: number): string {
  return `97000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function userId(value: number): UserId {
  return uuid(value) as UserId;
}
