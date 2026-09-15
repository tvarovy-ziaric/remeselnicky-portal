import type { UserId } from "@portal/domain";
import {
  createObjectStorageService,
  defineStorageTopology,
  type ObjectStorageAdapter,
} from "@portal/storage";
import { describe, expect, it, vi } from "vitest";

import {
  asStorageObjectKey,
  createPrivateMediaDeliveryService,
  createPublicPortfolioDeliveryService,
  createServerMediaEntityAccess,
  type PrivateMediaAccessGrant,
  type PrivateMediaDeliveryRepository,
  type PrivateMediaDeliverySnapshot,
  type PublicPortfolioDerivativeSnapshot,
} from "../src/index.js";

const aliceId = "11111111-1111-4111-8111-111111111111" as UserId;
const bobId = "22222222-2222-4222-8222-222222222222" as UserId;
const assetId = "33333333-3333-4333-8333-333333333333";
const entityId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-14T12:00:00.000Z");
const privateKey = asStorageObjectKey(
  "private/2026/09/66666666-6666-4666-8666-666666666666",
);
const publicKey = asStorageObjectKey(
  "public-derivative/2026/09/77777777-7777-4777-8777-777777777777",
);

function snapshot(
  overrides: Partial<PrivateMediaDeliverySnapshot> = {},
): PrivateMediaDeliverySnapshot {
  return {
    actor: { accountState: "ACTIVE", userId: aliceId },
    asset: {
      id: assetId,
      ownerUserId: aliceId,
      provenanceEntityId: entityId,
      provenanceEntityRevision: 1,
      provenanceEntityType: "JOB",
      purpose: "JOB_DOCUMENT",
      status: "READY",
      updatedAt: now,
    },
    object: {
      contentType: "application/pdf",
      createdAt: now,
      id: objectId,
      revokedAt: null,
      role: "CANONICAL",
      storageObject: { area: "private", key: privateKey },
    },
    ...overrides,
  };
}

function storage(
  input: {
    readonly downloadUrl?: string;
    readonly storageNow?: Date;
  } = {},
) {
  const issuePrivateDownload = vi.fn(() =>
    Promise.resolve(
      new URL(
        input.downloadUrl ??
          "https://private-storage.invalid/object?signature=opaque",
      ),
    ),
  );
  const revokeDerivative = vi.fn(() => Promise.resolve());
  const adapter: ObjectStorageAdapter = {
    issuePrivateDownload,
    publishDerivative: vi.fn(() =>
      Promise.resolve(new URL("https://cdn.invalid/public.webp")),
    ),
    put: vi.fn(() => Promise.resolve()),
    readPrivate: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
    revokeDerivative,
  };
  return {
    issuePrivateDownload,
    revokeDerivative,
    service: createObjectStorageService({
      adapter,
      now: () => input.storageNow ?? now,
      topology: defineStorageTopology({
        privateContainer: "portal-private",
        publicDerivativeContainer: "portal-public",
      }),
    }),
  };
}

function privateService(input: {
  readonly access?: readonly PrivateMediaAccessGrant[];
  readonly clock?: () => Date;
  readonly downloadUrl?: string;
  readonly repository?: PrivateMediaDeliveryRepository;
  readonly snapshot?: PrivateMediaDeliverySnapshot | null;
  readonly storageNow?: Date;
}) {
  const storageFixture = storage({
    ...(input.downloadUrl === undefined
      ? {}
      : { downloadUrl: input.downloadUrl }),
    ...(input.storageNow === undefined ? {} : { storageNow: input.storageNow }),
  });
  const loadPrivateDeliverySnapshot = vi.fn(() =>
    Promise.resolve(input.snapshot === undefined ? snapshot() : input.snapshot),
  );
  const repository = input.repository ?? { loadPrivateDeliverySnapshot };
  const resolvePrivateMediaAccess = vi.fn(() =>
    Promise.resolve(
      createServerMediaEntityAccess({
        ...(input.access === undefined ? {} : { grants: input.access }),
        revision: "entity-v1",
      }),
    ),
  );
  return {
    issuePrivateDownload: storageFixture.issuePrivateDownload,
    loadPrivateDeliverySnapshot,
    resolvePrivateMediaAccess,
    service: createPrivateMediaDeliveryService({
      applicationOrigin: "https://app.example.test",
      clock: input.clock ?? (() => now),
      entityAccess: { resolvePrivateMediaAccess },
      repository,
      storage: storageFixture.service,
    }),
  };
}

describe("private media delivery", () => {
  it("re-authorizes an ACTIVE owner around a short-lived safe signed grant", async () => {
    const fixture = privateService({});
    const response = await fixture.service.handleDownload({
      actorUserId: aliceId,
      mediaAssetId: assetId,
    });

    expect(response).toEqual({
      headers: {
        "cache-control": "private, no-store",
        location: "https://private-storage.invalid/object?signature=opaque",
        "referrer-policy": "no-referrer",
      },
      statusCode: 303,
    });
    expect(fixture.loadPrivateDeliverySnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.resolvePrivateMediaAccess).toHaveBeenCalledTimes(2);
    expect(fixture.issuePrivateDownload).toHaveBeenCalledWith({
      container: "portal-private",
      contentDisposition: 'attachment; filename="portal-document.pdf"',
      contentType: "application/pdf",
      expiresAt: new Date("2026-09-14T12:00:45.000Z"),
      key: privateKey,
    });
  });

  it("returns the same denial for missing, malformed and cross-owner IDs", async () => {
    const absent = privateService({ snapshot: null });
    const wrongOwner = privateService({
      snapshot: snapshot({
        actor: { accountState: "ACTIVE", userId: bobId },
      }),
    });

    const responses = await Promise.all([
      absent.service.handleDownload({
        actorUserId: bobId,
        mediaAssetId: assetId,
      }),
      wrongOwner.service.handleDownload({
        actorUserId: bobId,
        mediaAssetId: assetId,
      }),
      wrongOwner.service.handleDownload({
        actorUserId: bobId,
        mediaAssetId: "../private/object",
      }),
      wrongOwner.service.handleDownload({ mediaAssetId: assetId }),
    ]);

    expect(responses).toEqual(
      Array.from({ length: 4 }, () => ({
        body: { code: "MEDIA_NOT_FOUND" },
        headers: { "cache-control": "private, no-store" },
        statusCode: 404,
      })),
    );
    expect(wrongOwner.issuePrivateDownload).not.toHaveBeenCalled();
  });

  it.each(["SUSPENDED", "DEACTIVATED"] as const)(
    "denies a current %s actor even if a stale session still has their ID",
    async (accountState) => {
      const fixture = privateService({
        snapshot: snapshot({ actor: { accountState, userId: aliceId } }),
      });
      await expect(
        fixture.service.handleDownload({
          actorUserId: aliceId,
          mediaAssetId: assetId,
        }),
      ).resolves.toMatchObject({ statusCode: 404 });
      expect(fixture.issuePrivateDownload).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "processing",
      snapshot({ asset: { ...snapshot().asset, status: "PROCESSING" } }),
    ],
    [
      "rejected",
      snapshot({ asset: { ...snapshot().asset, status: "REJECTED" } }),
    ],
    ["revoked", snapshot({ object: { ...snapshot().object, revokedAt: now } })],
    [
      "original/non-canonical",
      snapshot({
        object: {
          ...snapshot().object,
          role: "ORIGINAL_UPLOAD" as "CANONICAL",
        },
      }),
    ],
    [
      "public-area",
      snapshot({
        object: {
          ...snapshot().object,
          storageObject: { area: "public-derivative", key: publicKey },
        },
      }),
    ],
    [
      "active-content",
      snapshot({ object: { ...snapshot().object, contentType: "text/html" } }),
    ],
    [
      "unbound/orphan",
      snapshot({
        asset: {
          ...snapshot().asset,
          provenanceEntityId: null,
          provenanceEntityType: null,
        },
      }),
    ],
  ])("denies a %s asset before signing", async (_case, value) => {
    const fixture = privateService({ snapshot: value });
    await expect(
      fixture.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 404 });
    expect(fixture.issuePrivateDownload).not.toHaveBeenCalled();
  });

  it.each([
    ["JOB_REQUEST_IMAGE", "INVITED_PROVIDER"],
    ["JOB_REQUEST_DOCUMENT", "INVITED_PROVIDER"],
    ["JOB_DOCUMENT", "JOB_CUSTOMER"],
    ["JOB_IMAGE", "JOB_PRIMARY_PROVIDER"],
    ["JOB_IMAGE", "JOB_EXECUTION_PARTICIPANT"],
    ["CHAT_DOCUMENT", "CONVERSATION_MEMBER"],
    ["QUOTE_DOCUMENT", "QUOTE_REQUEST_CUSTOMER"],
    ["CHANGE_ORDER_DOCUMENT", "JOB_COMMERCIAL_PARTICIPANT"],
    ["CREDENTIAL_DOCUMENT", "CREDENTIAL_REVIEWER"],
    ["CREDENTIAL_IMAGE", "CREDENTIAL_REVIEWER"],
    ["DISPUTE_EVIDENCE", "DISPUTE_CASE_MEMBER"],
    ["PORTFOLIO_IMAGE", "PORTFOLIO_PROJECT_OWNER"],
  ] as const)("allows %s only with its %s relation", async (purpose, grant) => {
    const fixture = privateService({
      access: [grant],
      snapshot: snapshot({
        actor: { accountState: "ACTIVE", userId: bobId },
        asset: { ...snapshot().asset, purpose },
      }),
    });
    await expect(
      fixture.service.handleDownload({
        actorUserId: bobId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 303 });
  });

  it("requires current portfolio attachment authorization even from the asset owner", async () => {
    const denied = privateService({
      snapshot: snapshot({
        asset: { ...snapshot().asset, purpose: "PORTFOLIO_IMAGE" },
      }),
    });
    await expect(
      denied.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 404 });
    expect(denied.issuePrivateDownload).not.toHaveBeenCalled();
  });

  it.each([
    ["JOB_REQUEST_IMAGE", "JOB_EXECUTION_PARTICIPANT"],
    ["JOB_REQUEST_DOCUMENT", "JOB_CUSTOMER"],
    ["JOB_DOCUMENT", "INVITED_PROVIDER"],
    ["CHAT_DOCUMENT", "JOB_EXECUTION_PARTICIPANT"],
    ["QUOTE_DOCUMENT", "CONVERSATION_MEMBER"],
    ["CHANGE_ORDER_DOCUMENT", "JOB_EXECUTION_PARTICIPANT"],
    ["DISPUTE_EVIDENCE", "JOB_CUSTOMER"],
    ["CREDENTIAL_IMAGE", "JOB_CUSTOMER"],
    ["PORTFOLIO_IMAGE", "INVITED_PROVIDER"],
  ] as const)(
    "denies wrong-role access: %s with %s",
    async (purpose, grant) => {
      const fixture = privateService({
        access: [grant],
        snapshot: snapshot({
          actor: { accountState: "ACTIVE", userId: bobId },
          asset: { ...snapshot().asset, purpose },
        }),
      });
      await expect(
        fixture.service.handleDownload({
          actorUserId: bobId,
          mediaAssetId: assetId,
        }),
      ).resolves.toMatchObject({ statusCode: 404 });
      expect(fixture.issuePrivateDownload).not.toHaveBeenCalled();
    },
  );

  it("does not return a signed URL after a concurrent revocation", async () => {
    const loadPrivateDeliverySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot({ object: { ...snapshot().object, revokedAt: now } }),
      );
    const fixture = privateService({
      repository: { loadPrivateDeliverySnapshot },
    });

    const response = await fixture.service.handleDownload({
      actorUserId: aliceId,
      mediaAssetId: assetId,
    });
    expect(response).toMatchObject({ statusCode: 404 });
    expect(JSON.stringify(response)).not.toContain("private-storage");
    expect(fixture.issuePrivateDownload).toHaveBeenCalledOnce();
  });

  it("rejects a repository projection that does not match the requested IDs", async () => {
    const actorMismatch = privateService({
      snapshot: snapshot({
        actor: { accountState: "ACTIVE", userId: bobId },
      }),
    });
    const assetMismatch = privateService({
      snapshot: snapshot({
        asset: {
          ...snapshot().asset,
          id: "88888888-8888-4888-8888-888888888888",
        },
      }),
    });
    await expect(
      actorMismatch.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      assetMismatch.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 404 });
    expect(actorMismatch.issuePrivateDownload).not.toHaveBeenCalled();
    expect(assetMismatch.issuePrivateDownload).not.toHaveBeenCalled();
  });

  it("does not return a signed URL when entity access changes during issuance", async () => {
    const storageFixture = storage();
    const resolvePrivateMediaAccess = vi
      .fn()
      .mockResolvedValueOnce(
        createServerMediaEntityAccess({
          grants: ["JOB_EXECUTION_PARTICIPANT"],
          revision: "membership-v1",
        }),
      )
      .mockResolvedValueOnce(
        createServerMediaEntityAccess({
          grants: [],
          revision: "membership-v2",
        }),
      );
    const service = createPrivateMediaDeliveryService({
      applicationOrigin: "https://app.example.test",
      clock: () => now,
      entityAccess: { resolvePrivateMediaAccess },
      repository: {
        loadPrivateDeliverySnapshot: () =>
          Promise.resolve(
            snapshot({
              actor: { accountState: "ACTIVE", userId: bobId },
              asset: { ...snapshot().asset, purpose: "JOB_IMAGE" },
            }),
          ),
      },
      storage: storageFixture.service,
    });
    const response = await service.handleDownload({
      actorUserId: bobId,
      mediaAssetId: assetId,
    });
    expect(response).toMatchObject({ statusCode: 404 });
    expect(JSON.stringify(response)).not.toContain("private-storage");
    expect(storageFixture.issuePrivateDownload).toHaveBeenCalledOnce();
  });

  it("does not return an already-expired or unsafe-origin grant", async () => {
    const times = [now, new Date(now.valueOf() + 46_000)];
    const expired = privateService({ clock: () => times.shift() ?? times[0]! });
    await expect(
      expired.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 503 });

    for (const unsafeUrl of [
      "http://private-storage.invalid/object?signature=opaque",
      "https://app.example.test/private/object?signature=opaque",
      "https://user:password@private-storage.invalid/object",
    ]) {
      const fixture = privateService({ downloadUrl: unsafeUrl });
      const response = await fixture.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      });
      expect(response).toMatchObject({ statusCode: 503 });
      expect(JSON.stringify(response)).not.toContain(unsafeUrl);
    }
  });

  it("rejects clock rollback and a signer expiry beyond the requested bound", async () => {
    const rollbackTimes = [now, new Date(now.valueOf() - 1)];
    const rollback = privateService({
      clock: () => rollbackTimes.shift() ?? now,
    });
    await expect(
      rollback.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 503 });

    const futureExpiry = privateService({
      clock: () => now,
      storageNow: new Date(now.valueOf() + 1_000),
    });
    await expect(
      futureExpiry.service.handleDownload({
        actorUserId: aliceId,
        mediaAssetId: assetId,
      }),
    ).resolves.toMatchObject({ statusCode: 503 });
  });

  it("fails closed when the current entity relation cannot be resolved", async () => {
    const storageFixture = storage();
    const service = createPrivateMediaDeliveryService({
      applicationOrigin: "https://app.example.test",
      clock: () => now,
      entityAccess: {
        resolvePrivateMediaAccess: () =>
          Promise.reject(new Error("relation store unavailable")),
      },
      repository: {
        loadPrivateDeliverySnapshot: () => Promise.resolve(snapshot()),
      },
      storage: storageFixture.service,
    });
    const response = await service.handleDownload({
      actorUserId: aliceId,
      mediaAssetId: assetId,
    });
    expect(response).toEqual({
      body: { code: "MEDIA_NOT_FOUND" },
      headers: { "cache-control": "private, no-store" },
      statusCode: 404,
    });
    expect(JSON.stringify(response)).not.toContain("relation store");
    expect(storageFixture.issuePrivateDownload).not.toHaveBeenCalled();
  });

  it("bounds private grant lifetime independently of the storage maximum", () => {
    const storageFixture = storage();
    expect(() =>
      createPrivateMediaDeliveryService({
        applicationOrigin: "https://app.example.test",
        entityAccess: {
          resolvePrivateMediaAccess: () =>
            Promise.resolve(
              createServerMediaEntityAccess({ revision: "entity-v1" }),
            ),
        },
        repository: {
          loadPrivateDeliverySnapshot: () => Promise.resolve(snapshot()),
        },
        storage: storageFixture.service,
        ttlSeconds: 61,
      }),
    ).toThrow(/between 1 and 60/u);
  });
});

function publicSnapshot(
  overrides: Partial<PublicPortfolioDerivativeSnapshot> = {},
): PublicPortfolioDerivativeSnapshot {
  return {
    assetId,
    assetStatus: "READY",
    contentType: "image/webp",
    objectId,
    publicationRevision: "publication-v1",
    publicationState: "PUBLIC",
    purpose: "PORTFOLIO_IMAGE",
    revokedAt: null,
    role: "DETAIL",
    storageObject: { area: "public-derivative", key: publicKey },
    url: new URL("https://cdn.invalid/portfolio.webp"),
    ...overrides,
  };
}

describe("public portfolio derivative delivery", () => {
  it("has a separate, narrow public path", async () => {
    const storageFixture = storage();
    const repository = {
      loadPublicPortfolioDerivative: vi.fn(() =>
        Promise.resolve(publicSnapshot()),
      ),
      markPublicDerivativeRevoked: vi.fn(() =>
        Promise.resolve("REVOKED" as const),
      ),
    };
    const service = createPublicPortfolioDeliveryService({
      repository,
      storage: storageFixture.service,
    });
    await expect(service.resolve(assetId)).resolves.toEqual({
      headers: {
        "cache-control": "private, no-store",
        location: "https://cdn.invalid/portfolio.webp",
        "x-content-type-options": "nosniff",
      },
      statusCode: 302,
    });
  });

  it.each([
    publicSnapshot({ publicationState: "HIDDEN" }),
    publicSnapshot({ publicationState: "MODERATION_RESTRICTED" }),
    publicSnapshot({ revokedAt: now }),
    publicSnapshot({ assetStatus: "PROCESSING" }),
    publicSnapshot({ purpose: "JOB_IMAGE" }),
    publicSnapshot({ storageObject: { area: "private", key: privateKey } }),
    publicSnapshot({ contentType: "image/svg+xml" }),
    publicSnapshot({
      url: new URL("https://cdn.invalid/portfolio.webp?opaque=secret"),
    }),
  ])(
    "never promotes or exposes a non-public canonical object",
    async (value) => {
      const service = createPublicPortfolioDeliveryService({
        repository: {
          loadPublicPortfolioDerivative: () => Promise.resolve(value),
          markPublicDerivativeRevoked: () => Promise.resolve("STALE"),
        },
        storage: storage().service,
      });
      await expect(service.resolve(assetId)).resolves.toMatchObject({
        statusCode: 404,
      });
    },
  );

  it("revokes only after an authoritative hide/moderation state", async () => {
    const storageFixture = storage();
    const markPublicDerivativeRevoked = vi.fn(() =>
      Promise.resolve("REVOKED" as const),
    );
    const values = [
      publicSnapshot(),
      publicSnapshot({
        publicationRevision: "publication-v2",
        publicationState: "MODERATION_RESTRICTED",
      }),
    ];
    const service = createPublicPortfolioDeliveryService({
      repository: {
        loadPublicPortfolioDerivative: () => Promise.resolve(values.shift()!),
        markPublicDerivativeRevoked,
      },
      storage: storageFixture.service,
    });

    await expect(service.revokeHiddenOrModerated(assetId)).resolves.toBe(
      "NOT_FOUND",
    );
    expect(storageFixture.revokeDerivative).not.toHaveBeenCalled();
    await expect(service.revokeHiddenOrModerated(assetId)).resolves.toBe(
      "REVOKED",
    );
    expect(storageFixture.revokeDerivative).toHaveBeenCalledWith({
      container: "portal-public",
      key: publicKey,
    });
    expect(markPublicDerivativeRevoked).toHaveBeenCalledWith({
      objectId,
      publicationRevision: "publication-v2",
    });
  });
});
