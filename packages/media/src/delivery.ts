import type { UserAccountState, UserId } from "@portal/domain";
import {
  createAuthenticatedAuthorizationActor,
  createAuthorizationEvaluator,
  createServerAuthorizationContext,
  defineAuthorizationPolicy,
  denyAuthorization,
  permitAuthorization,
  resolveAuthorizationTarget,
} from "@portal/authorization";
import type {
  ObjectStorageService,
  StoredObjectReference,
  StorageObjectKey,
} from "@portal/storage";

import type {
  MediaAssetStatus,
  MediaProvenanceEntityType,
  MediaUploadPurpose,
} from "./model.js";

export const PRIVATE_MEDIA_DOWNLOAD_PATH = "/v1/media/:mediaAssetId/download";
export const PUBLIC_PORTFOLIO_MEDIA_PATH = "/v1/public/media/:mediaAssetId";

export const PRIVATE_MEDIA_ACCESS_GRANTS = Object.freeze([
  "INVITED_PROVIDER",
  "JOB_CUSTOMER",
  "JOB_EXECUTION_PARTICIPANT",
  "JOB_PRIMARY_PROVIDER",
  "JOB_COMMERCIAL_PARTICIPANT",
  "CONVERSATION_MEMBER",
  "QUOTE_AUTHOR",
  "QUOTE_REQUEST_CUSTOMER",
  "CREDENTIAL_REVIEWER",
  "DISPUTE_CASE_MEMBER",
  "DISPUTE_REVIEWER",
  "PORTFOLIO_PROJECT_OWNER",
] as const);

export type PrivateMediaAccessGrant =
  (typeof PRIVATE_MEDIA_ACCESS_GRANTS)[number];

export interface PrivateMediaDeliverySnapshot {
  readonly actor: {
    readonly accountState: UserAccountState;
    readonly userId: UserId;
  };
  readonly asset: {
    readonly id: string;
    readonly ownerUserId: UserId;
    readonly provenanceEntityId: string | null;
    readonly provenanceEntityRevision: number | null;
    readonly provenanceEntityType: MediaProvenanceEntityType | null;
    readonly purpose: MediaUploadPurpose;
    readonly status: MediaAssetStatus;
    readonly updatedAt: Date;
  };
  readonly object: {
    readonly contentType: string;
    readonly createdAt: Date;
    readonly id: string;
    readonly revokedAt: Date | null;
    readonly role: "CANONICAL";
    readonly storageObject: StoredObjectReference;
  };
}

const trustedEntityAccess = Symbol("portal.media.trusted-delivery-context");

export interface ServerMediaEntityAccess {
  readonly grants: readonly PrivateMediaAccessGrant[];
  readonly revision: string;
  readonly [trustedEntityAccess]: true;
}

export function createServerMediaEntityAccess(input: {
  readonly grants?: readonly PrivateMediaAccessGrant[];
  readonly revision: string;
}): ServerMediaEntityAccess {
  if (
    typeof input.revision !== "string" ||
    input.revision.length < 1 ||
    input.revision.length > 200 ||
    /[\r\n]/u.test(input.revision)
  ) {
    throw new Error("Media entity access requires a bounded server revision");
  }
  const grants = [...new Set(input.grants ?? [])];
  if (grants.some((grant) => !PRIVATE_MEDIA_ACCESS_GRANTS.includes(grant))) {
    throw new Error("Media entity access contains an unsupported grant");
  }
  return Object.freeze({
    grants: Object.freeze(grants),
    revision: input.revision,
    [trustedEntityAccess]: true as const,
  });
}

export interface PrivateMediaDeliveryRepository {
  /** One authoritative query must reload both the actor and selected object. */
  loadPrivateDeliverySnapshot(input: {
    readonly actorUserId: string;
    readonly mediaAssetId: string;
  }): Promise<PrivateMediaDeliverySnapshot | null>;
}

export interface MediaEntityAccessResolver {
  /** Resolve current domain relations; never derive grants from request input. */
  resolvePrivateMediaAccess(
    snapshot: PrivateMediaDeliverySnapshot,
  ): Promise<ServerMediaEntityAccess>;
}

export type PrivateMediaEndpointResponse =
  | Readonly<{
      readonly body: Readonly<{ readonly code: "MEDIA_NOT_FOUND" }>;
      readonly headers: Readonly<Record<"cache-control", string>>;
      readonly statusCode: 404;
    }>
  | Readonly<{
      readonly headers: Readonly<
        Record<"cache-control" | "location" | "referrer-policy", string>
      >;
      readonly statusCode: 303;
    }>
  | Readonly<{
      readonly body: Readonly<{ readonly code: "MEDIA_DELIVERY_UNAVAILABLE" }>;
      readonly headers: Readonly<Record<"cache-control", string>>;
      readonly statusCode: 503;
    }>;

const notFoundResponse: PrivateMediaEndpointResponse = Object.freeze({
  body: Object.freeze({ code: "MEDIA_NOT_FOUND" as const }),
  headers: Object.freeze({ "cache-control": "private, no-store" }),
  statusCode: 404 as const,
});
const unavailableResponse: PrivateMediaEndpointResponse = Object.freeze({
  body: Object.freeze({ code: "MEDIA_DELIVERY_UNAVAILABLE" as const }),
  headers: Object.freeze({ "cache-control": "private, no-store" }),
  statusCode: 503 as const,
});

interface PrivateMediaPolicyContext {
  readonly access: ServerMediaEntityAccess;
}

const privateMediaDownloadPolicy = defineAuthorizationPolicy<
  "media.asset",
  "download.private",
  PrivateMediaDeliverySnapshot["asset"],
  PrivateMediaPolicyContext
>({
  accountRequirement: "ACTIVE",
  action: "download.private",
  evaluate: ({ actor, context, target }) => {
    if (!isTrustedEntityAccess(context.access)) return denyAuthorization();
    if (
      target.status !== "READY" ||
      target.provenanceEntityType === null ||
      target.provenanceEntityId === null
    ) {
      return denyAuthorization();
    }
    if (
      actor.userId === target.ownerUserId &&
      target.purpose !== "PORTFOLIO_IMAGE"
    ) {
      return permitAuthorization();
    }

    const allowed = allowedGrantsForPurpose(target.purpose);
    return context.access.grants.some((grant) => allowed.has(grant))
      ? permitAuthorization()
      : denyAuthorization();
  },
  resource: "media.asset",
});
const privateMediaAuthorization = createAuthorizationEvaluator([
  privateMediaDownloadPolicy,
]);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeCanonicalContentTypes = new Set(["application/pdf", "image/webp"]);
const maximumDeliveryTtlSeconds = 60;

export function createPrivateMediaDeliveryService(input: {
  readonly applicationOrigin: string;
  readonly clock?: () => Date;
  readonly entityAccess: MediaEntityAccessResolver;
  readonly repository: PrivateMediaDeliveryRepository;
  readonly storage: ObjectStorageService;
  readonly ttlSeconds?: number;
}) {
  const applicationOrigin = new URL(input.applicationOrigin).origin;
  const clock = input.clock ?? (() => new Date());
  const ttlSeconds = input.ttlSeconds ?? 45;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > maximumDeliveryTtlSeconds
  ) {
    throw new Error("Private media TTL must be between 1 and 60 seconds");
  }

  return Object.freeze({
    async handleDownload(request: {
      readonly actorUserId?: string;
      readonly mediaAssetId: string;
    }): Promise<PrivateMediaEndpointResponse> {
      if (
        request.actorUserId === undefined ||
        !uuidPattern.test(request.actorUserId) ||
        !uuidPattern.test(request.mediaAssetId)
      ) {
        return notFoundResponse;
      }
      const authorizedRequest = {
        actorUserId: request.actorUserId,
        mediaAssetId: request.mediaAssetId,
      };

      const first = await loadAndAuthorize(input, authorizedRequest);
      if (first === null) return notFoundResponse;

      const issuedAt = clock();
      if (!Number.isFinite(issuedAt.valueOf())) return unavailableResponse;

      let grant;
      try {
        grant = await input.storage.createPrivateDownload({
          authorizationGranted: true,
          contentDisposition:
            first.snapshot.object.contentType === "image/webp"
              ? "inline"
              : "attachment",
          contentType: first.snapshot.object.contentType,
          object: first.snapshot.object.storageObject,
          ttlSeconds,
        });
      } catch {
        return unavailableResponse;
      }

      // Re-authorize after signing so a concurrent account/relation/object
      // revocation cannot expose the already-created grant in this response.
      const second = await loadAndAuthorize(input, authorizedRequest);
      if (
        second === null ||
        !sameDeliverySnapshot(first.snapshot, second.snapshot) ||
        first.access.revision !== second.access.revision
      ) {
        return notFoundResponse;
      }

      const returnedAt = clock();
      if (
        !isUsableGrant({
          applicationOrigin,
          expiresAt: grant.expiresAt,
          issuedAt,
          returnedAt,
          ttlSeconds,
          url: grant.url,
        })
      ) {
        return unavailableResponse;
      }

      return Object.freeze({
        headers: Object.freeze({
          "cache-control": "private, no-store",
          location: grant.url.toString(),
          "referrer-policy": "no-referrer",
        }),
        statusCode: 303 as const,
      });
    },
  });
}

async function loadAndAuthorize(
  input: Pick<
    Parameters<typeof createPrivateMediaDeliveryService>[0],
    "entityAccess" | "repository"
  >,
  request: { readonly actorUserId: string; readonly mediaAssetId: string },
): Promise<Readonly<{
  readonly access: ServerMediaEntityAccess;
  readonly snapshot: PrivateMediaDeliverySnapshot;
}> | null> {
  let snapshot: PrivateMediaDeliverySnapshot | null;
  let access: ServerMediaEntityAccess;
  try {
    snapshot = await input.repository.loadPrivateDeliverySnapshot(request);
    if (
      snapshot === null ||
      snapshot.actor.userId !== request.actorUserId ||
      snapshot.asset.id !== request.mediaAssetId ||
      !isDeliverableObject(snapshot)
    ) {
      return null;
    }
    access = await input.entityAccess.resolvePrivateMediaAccess(snapshot);
  } catch {
    return null;
  }
  if (!isTrustedEntityAccess(access)) return null;

  const decision = await privateMediaAuthorization.authorize(
    privateMediaDownloadPolicy,
    {
      actor: createAuthenticatedAuthorizationActor({
        accountState: snapshot.actor.accountState,
        id: snapshot.actor.userId,
      }),
      context: createServerAuthorizationContext({ access }),
      target: resolveAuthorizationTarget(snapshot.asset),
    },
  );
  return decision.effect === "PERMIT"
    ? Object.freeze({ access, snapshot })
    : null;
}

function isDeliverableObject(snapshot: PrivateMediaDeliverySnapshot): boolean {
  return (
    snapshot.actor.userId.length > 0 &&
    snapshot.asset.status === "READY" &&
    snapshot.object.role === "CANONICAL" &&
    snapshot.object.storageObject.area === "private" &&
    snapshot.object.revokedAt === null &&
    safeCanonicalContentTypes.has(snapshot.object.contentType) &&
    Number.isFinite(snapshot.asset.updatedAt.valueOf()) &&
    Number.isFinite(snapshot.object.createdAt.valueOf())
  );
}

function isTrustedEntityAccess(value: ServerMediaEntityAccess): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value[trustedEntityAccess] === true &&
    typeof value.revision === "string" &&
    value.grants.every((grant) => PRIVATE_MEDIA_ACCESS_GRANTS.includes(grant))
  );
}

function allowedGrantsForPurpose(
  purpose: MediaUploadPurpose,
): ReadonlySet<PrivateMediaAccessGrant> {
  switch (purpose) {
    case "JOB_REQUEST_IMAGE":
      return new Set(["INVITED_PROVIDER"]);
    case "JOB_IMAGE":
    case "JOB_DOCUMENT":
      return new Set([
        "JOB_CUSTOMER",
        "JOB_PRIMARY_PROVIDER",
        "JOB_EXECUTION_PARTICIPANT",
      ]);
    case "CHAT_IMAGE":
    case "CHAT_DOCUMENT":
      return new Set(["CONVERSATION_MEMBER"]);
    case "CREDENTIAL_DOCUMENT":
    case "CREDENTIAL_IMAGE":
      return new Set(["CREDENTIAL_REVIEWER"]);
    case "QUOTE_DOCUMENT":
      return new Set(["QUOTE_AUTHOR", "QUOTE_REQUEST_CUSTOMER"]);
    case "CHANGE_ORDER_DOCUMENT":
      return new Set([
        "JOB_CUSTOMER",
        "JOB_PRIMARY_PROVIDER",
        "JOB_COMMERCIAL_PARTICIPANT",
      ]);
    case "DISPUTE_EVIDENCE":
      return new Set(["DISPUTE_CASE_MEMBER", "DISPUTE_REVIEWER"]);
    case "PROFILE_IMAGE":
      return new Set();
    case "PORTFOLIO_IMAGE":
      return new Set(["PORTFOLIO_PROJECT_OWNER"]);
  }
}

function sameDeliverySnapshot(
  first: PrivateMediaDeliverySnapshot,
  second: PrivateMediaDeliverySnapshot,
): boolean {
  return (
    first.actor.userId === second.actor.userId &&
    first.actor.accountState === second.actor.accountState &&
    first.asset.id === second.asset.id &&
    first.asset.ownerUserId === second.asset.ownerUserId &&
    first.asset.status === second.asset.status &&
    first.asset.purpose === second.asset.purpose &&
    first.asset.provenanceEntityType === second.asset.provenanceEntityType &&
    first.asset.provenanceEntityId === second.asset.provenanceEntityId &&
    first.asset.provenanceEntityRevision ===
      second.asset.provenanceEntityRevision &&
    first.asset.updatedAt.valueOf() === second.asset.updatedAt.valueOf() &&
    first.object.id === second.object.id &&
    first.object.role === second.object.role &&
    first.object.contentType === second.object.contentType &&
    first.object.revokedAt?.valueOf() === second.object.revokedAt?.valueOf() &&
    first.object.storageObject.area === second.object.storageObject.area &&
    first.object.storageObject.key === second.object.storageObject.key &&
    first.object.createdAt.valueOf() === second.object.createdAt.valueOf()
  );
}

function isUsableGrant(input: {
  readonly applicationOrigin: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly returnedAt: Date;
  readonly ttlSeconds: number;
  readonly url: URL;
}): boolean {
  const expiresAt = input.expiresAt.valueOf();
  const issuedAt = input.issuedAt.valueOf();
  const returnedAt = input.returnedAt.valueOf();
  return (
    input.url.protocol === "https:" &&
    input.url.origin !== input.applicationOrigin &&
    input.url.username === "" &&
    input.url.password === "" &&
    input.url.hash === "" &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(issuedAt) &&
    Number.isFinite(returnedAt) &&
    returnedAt >= issuedAt &&
    expiresAt > issuedAt &&
    expiresAt > returnedAt &&
    expiresAt <= issuedAt + input.ttlSeconds * 1_000
  );
}

export interface PublicPortfolioDerivativeSnapshot {
  readonly assetId: string;
  readonly assetStatus: MediaAssetStatus;
  readonly contentType: string;
  readonly objectId: string;
  readonly publicationRevision: string;
  readonly publicationState: "HIDDEN" | "MODERATION_RESTRICTED" | "PUBLIC";
  readonly purpose: MediaUploadPurpose;
  readonly revokedAt: Date | null;
  readonly role: "DETAIL" | "THUMBNAIL";
  readonly storageObject: StoredObjectReference;
  readonly url: URL;
}

export interface PublicPortfolioDeliveryRepository {
  loadPublicPortfolioDerivative(
    mediaAssetId: string,
  ): Promise<PublicPortfolioDerivativeSnapshot | null>;
  markPublicDerivativeRevoked(input: {
    readonly objectId: string;
    readonly publicationRevision: string;
  }): Promise<"REVOKED" | "STALE">;
}

export function createPublicPortfolioDeliveryService(input: {
  readonly repository: PublicPortfolioDeliveryRepository;
  readonly storage: Pick<ObjectStorageService, "revokePublicDerivative">;
}) {
  return Object.freeze({
    async resolve(mediaAssetId: string) {
      if (!uuidPattern.test(mediaAssetId)) return notFoundResponse;
      const snapshot =
        await input.repository.loadPublicPortfolioDerivative(mediaAssetId);
      if (!isPublicPortfolioDerivative(snapshot)) return notFoundResponse;
      return Object.freeze({
        headers: Object.freeze({
          "cache-control": "public, max-age=30, must-revalidate",
          location: snapshot.url.toString(),
          "x-content-type-options": "nosniff",
        }),
        statusCode: 302 as const,
      });
    },

    async revokeHiddenOrModerated(mediaAssetId: string) {
      if (!uuidPattern.test(mediaAssetId)) return "NOT_FOUND" as const;
      const snapshot =
        await input.repository.loadPublicPortfolioDerivative(mediaAssetId);
      if (
        snapshot === null ||
        snapshot.publicationState === "PUBLIC" ||
        snapshot.storageObject.area !== "public-derivative" ||
        snapshot.revokedAt !== null
      ) {
        return "NOT_FOUND" as const;
      }
      await input.storage.revokePublicDerivative(snapshot.storageObject);
      return input.repository.markPublicDerivativeRevoked({
        objectId: snapshot.objectId,
        publicationRevision: snapshot.publicationRevision,
      });
    },
  });
}

function isPublicPortfolioDerivative(
  snapshot: PublicPortfolioDerivativeSnapshot | null,
): snapshot is PublicPortfolioDerivativeSnapshot {
  return (
    snapshot !== null &&
    snapshot.assetStatus === "READY" &&
    snapshot.purpose === "PORTFOLIO_IMAGE" &&
    snapshot.publicationState === "PUBLIC" &&
    snapshot.revokedAt === null &&
    snapshot.storageObject.area === "public-derivative" &&
    (snapshot.role === "DETAIL" || snapshot.role === "THUMBNAIL") &&
    snapshot.contentType === "image/webp" &&
    snapshot.url.protocol === "https:" &&
    snapshot.url.username === "" &&
    snapshot.url.password === "" &&
    snapshot.url.hash === ""
  );
}

export function asStorageObjectKey(value: string): StorageObjectKey {
  if (
    !/^(?:private|public-derivative)\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error("Persisted storage object key is invalid");
  }
  return value as StorageObjectKey;
}
