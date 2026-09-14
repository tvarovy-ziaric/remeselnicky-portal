import { randomUUID } from "node:crypto";

export const storageAreas = {
  private: "private",
  publicDerivative: "public-derivative",
} as const;

export type StorageArea = (typeof storageAreas)[keyof typeof storageAreas];
export type StorageObjectKey = string & {
  readonly __storageObjectKey: unique symbol;
};

export interface StorageTopology {
  readonly privateContainer: string;
  readonly publicDerivativeContainer: string;
}

export interface StoredObjectReference {
  readonly area: StorageArea;
  readonly key: StorageObjectKey;
}

export interface PrivateDownloadGrant {
  readonly expiresAt: Date;
  readonly url: URL;
}

export interface ObjectStorageAdapter {
  put(input: {
    readonly area: StorageArea;
    readonly body: Uint8Array;
    readonly container: string;
    readonly contentType: string;
    readonly key: StorageObjectKey;
  }): Promise<void>;
  readPrivate(input: {
    readonly container: string;
    readonly key: StorageObjectKey;
    /** Adapter must reject before returning a body larger than this bound. */
    readonly maximumBytes: number;
  }): Promise<Uint8Array>;
  issuePrivateDownload(input: {
    readonly container: string;
    readonly contentDisposition: string;
    readonly contentType: string;
    /** The adapter must bind and cryptographically enforce this expiry. */
    readonly expiresAt: Date;
    readonly key: StorageObjectKey;
  }): Promise<URL>;
  publishDerivative(input: {
    readonly container: string;
    readonly key: StorageObjectKey;
  }): Promise<URL>;
  revokeDerivative(input: {
    readonly container: string;
    readonly key: StorageObjectKey;
  }): Promise<void>;
}

export interface ObjectStorageService {
  storePrivate(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<StoredObjectReference>;
  storePublicDerivative(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<StoredObjectReference & { readonly url: URL }>;
  readPrivateForProcessing(input: {
    readonly maximumBytes: number;
    readonly object: StoredObjectReference;
  }): Promise<Uint8Array>;
  createPrivateDownload(input: {
    readonly authorizationGranted: boolean;
    readonly contentDisposition?: "attachment" | "inline";
    readonly contentType?: string;
    readonly object: StoredObjectReference;
    readonly ttlSeconds?: number;
  }): Promise<PrivateDownloadGrant>;
  revokePublicDerivative(object: StoredObjectReference): Promise<void>;
}

const maximumPrivateDownloadTtlSeconds = 300;
const safePrivateDownloadContentTypes = new Set([
  "application/octet-stream",
  "application/pdf",
  "image/webp",
]);

export function defineStorageTopology(input: StorageTopology): StorageTopology {
  const privateContainer = input.privateContainer.trim();
  const publicDerivativeContainer = input.publicDerivativeContainer.trim();

  if (privateContainer.length === 0 || publicDerivativeContainer.length === 0) {
    throw new Error("Storage container names must not be empty");
  }

  if (privateContainer === publicDerivativeContainer) {
    throw new Error(
      "Private and public derivative storage must use separate containers",
    );
  }

  return Object.freeze({ privateContainer, publicDerivativeContainer });
}

export function createStorageObjectKey(
  area: StorageArea,
  dependencies: {
    readonly now?: () => Date;
    readonly uuid?: () => string;
  } = {},
): StorageObjectKey {
  const now = (dependencies.now ?? (() => new Date()))();
  const uuid = (dependencies.uuid ?? randomUUID)();

  if (!Number.isFinite(now.valueOf())) {
    throw new Error("A valid server timestamp is required");
  }

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      uuid,
    )
  ) {
    throw new Error("A valid server-generated UUID is required");
  }

  const year = now.getUTCFullYear().toString().padStart(4, "0");
  const month = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${area}/${year}/${month}/${uuid.toLowerCase()}` as StorageObjectKey;
}

export function createObjectStorageService(input: {
  readonly adapter: ObjectStorageAdapter;
  readonly now?: () => Date;
  readonly topology: StorageTopology;
  readonly uuid?: () => string;
}): ObjectStorageService {
  defineStorageTopology(input.topology);
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? randomUUID;

  return {
    async storePrivate(objectInput) {
      const key = createStorageObjectKey(storageAreas.private, { now, uuid });
      await input.adapter.put({
        area: storageAreas.private,
        body: objectInput.body,
        container: input.topology.privateContainer,
        contentType: objectInput.contentType,
        key,
      });
      return { area: storageAreas.private, key };
    },

    async storePublicDerivative(objectInput) {
      const key = createStorageObjectKey(storageAreas.publicDerivative, {
        now,
        uuid,
      });
      await input.adapter.put({
        area: storageAreas.publicDerivative,
        body: objectInput.body,
        container: input.topology.publicDerivativeContainer,
        contentType: objectInput.contentType,
        key,
      });
      const url = await input.adapter.publishDerivative({
        container: input.topology.publicDerivativeContainer,
        key,
      });
      return { area: storageAreas.publicDerivative, key, url };
    },

    async readPrivateForProcessing(readInput) {
      if (readInput.object.area !== storageAreas.private) {
        throw new Error("Only private objects may enter server processing");
      }
      if (
        !Number.isSafeInteger(readInput.maximumBytes) ||
        readInput.maximumBytes < 1
      ) {
        throw new Error("A positive processing byte limit is required");
      }
      const body = await input.adapter.readPrivate({
        container: input.topology.privateContainer,
        key: readInput.object.key,
        maximumBytes: readInput.maximumBytes,
      });
      if (
        !(body instanceof Uint8Array) ||
        body.byteLength === 0 ||
        body.byteLength > readInput.maximumBytes
      ) {
        throw new Error("Private object violates the processing byte boundary");
      }
      return body;
    },

    async createPrivateDownload(downloadInput) {
      if (!downloadInput.authorizationGranted) {
        throw new Error("Private object access denied");
      }

      if (downloadInput.object.area !== storageAreas.private) {
        throw new Error("Only private objects use authorized download grants");
      }

      const ttlSeconds = downloadInput.ttlSeconds ?? 60;
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < 1 ||
        ttlSeconds > maximumPrivateDownloadTtlSeconds
      ) {
        throw new Error(
          "Private download TTL must be between 1 and 300 seconds",
        );
      }

      const contentType =
        downloadInput.contentType ?? "application/octet-stream";
      if (!safePrivateDownloadContentTypes.has(contentType)) {
        throw new Error("Private download content type is not allowlisted");
      }
      const disposition = downloadInput.contentDisposition ?? "attachment";
      if (disposition !== "attachment" && disposition !== "inline") {
        throw new Error("Private download disposition is invalid");
      }
      if (disposition === "inline" && contentType !== "image/webp") {
        throw new Error("Only canonical images may be rendered inline");
      }
      const safeFilename =
        contentType === "application/pdf"
          ? "portal-document.pdf"
          : contentType === "image/webp"
            ? "portal-image.webp"
            : "portal-file.bin";
      const contentDisposition = `${disposition}; filename="${safeFilename}"`;

      const expiresAt = new Date(now().valueOf() + ttlSeconds * 1_000);
      const url = await input.adapter.issuePrivateDownload({
        container: input.topology.privateContainer,
        contentDisposition,
        contentType,
        expiresAt,
        key: downloadInput.object.key,
      });
      return { expiresAt, url };
    },

    async revokePublicDerivative(object) {
      if (object.area !== storageAreas.publicDerivative) {
        throw new Error(
          "Only public derivatives can be revoked through the public delivery path",
        );
      }

      await input.adapter.revokeDerivative({
        container: input.topology.publicDerivativeContainer,
        key: object.key,
      });
    },
  };
}
