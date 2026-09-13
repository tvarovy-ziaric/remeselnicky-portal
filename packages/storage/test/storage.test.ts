import { describe, expect, it, vi } from "vitest";

import {
  createObjectStorageService,
  createStorageObjectKey,
  defineStorageTopology,
  storageAreas,
  type ObjectStorageAdapter,
} from "../src/index.js";

const fixedUuid = "123e4567-e89b-42d3-a456-426614174000";
const fixedNow = new Date("2026-09-14T12:00:00.000Z");

function createAdapter(): {
  adapter: ObjectStorageAdapter;
  issuePrivateDownload: ReturnType<typeof vi.fn>;
  publishDerivative: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  revokeDerivative: ReturnType<typeof vi.fn>;
} {
  const issuePrivateDownload = vi.fn(({ key }: { readonly key: string }) =>
    Promise.resolve(new URL(`https://private.invalid/${key}?signature=secret`)),
  );
  const publishDerivative = vi.fn(({ key }: { readonly key: string }) =>
    Promise.resolve(new URL(`https://cdn.invalid/${key}`)),
  );
  const put = vi.fn(() => Promise.resolve());
  const revokeDerivative = vi.fn(() => Promise.resolve());

  return {
    adapter: {
      issuePrivateDownload,
      publishDerivative,
      put,
      revokeDerivative,
    },
    issuePrivateDownload,
    publishDerivative,
    put,
    revokeDerivative,
  };
}

describe("storage topology", () => {
  it("requires physically separate private and public derivative containers", () => {
    expect(
      defineStorageTopology({
        privateContainer: "portal-private",
        publicDerivativeContainer: "portal-public-derivatives",
      }),
    ).toEqual({
      privateContainer: "portal-private",
      publicDerivativeContainer: "portal-public-derivatives",
    });

    expect(() =>
      defineStorageTopology({
        privateContainer: "portal-assets",
        publicDerivativeContainer: "portal-assets",
      }),
    ).toThrow(/separate containers/u);
  });

  it("creates opaque keys without accepting client filenames", () => {
    expect(
      createStorageObjectKey(storageAreas.private, {
        now: () => fixedNow,
        uuid: () => fixedUuid,
      }),
    ).toBe("private/2026/09/123e4567-e89b-42d3-a456-426614174000");
  });
});

describe("object storage service", () => {
  const topology = defineStorageTopology({
    privateContainer: "portal-private",
    publicDerivativeContainer: "portal-public-derivatives",
  });

  it("never returns a public URL when a private object is stored", async () => {
    const { adapter, publishDerivative, put } = createAdapter();
    const service = createObjectStorageService({
      adapter,
      now: () => fixedNow,
      topology,
      uuid: () => fixedUuid,
    });

    const stored = await service.storePrivate({
      body: new Uint8Array([1]),
      contentType: "image/webp",
    });

    expect(stored).toEqual({
      area: storageAreas.private,
      key: "private/2026/09/123e4567-e89b-42d3-a456-426614174000",
    });
    expect(publishDerivative).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        area: storageAreas.private,
        container: "portal-private",
      }),
    );
  });

  it("does not forward an untrusted client filename to the adapter", async () => {
    const { adapter, put } = createAdapter();
    const service = createObjectStorageService({
      adapter,
      now: () => fixedNow,
      topology,
      uuid: () => fixedUuid,
    });

    await service.storePrivate({
      body: new Uint8Array([1]),
      clientFilename: "../../public/overwrite.html",
      contentType: "image/webp",
    } as Parameters<typeof service.storePrivate>[0] & {
      readonly clientFilename: string;
    });

    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).not.toHaveProperty("clientFilename");
  });

  it("denies private delivery until an authorization decision is granted", async () => {
    const { adapter, issuePrivateDownload } = createAdapter();
    const service = createObjectStorageService({
      adapter,
      now: () => fixedNow,
      topology,
      uuid: () => fixedUuid,
    });
    const object = await service.storePrivate({
      body: new Uint8Array([1]),
      contentType: "application/pdf",
    });

    await expect(
      service.createPrivateDownload({ authorizationGranted: false, object }),
    ).rejects.toThrow(/denied/u);
    expect(issuePrivateDownload).not.toHaveBeenCalled();

    await expect(
      service.createPrivateDownload({
        authorizationGranted: true,
        object,
        ttlSeconds: 301,
      }),
    ).rejects.toThrow(/between 1 and 300/u);
  });

  it("uses a short-lived private grant and a separately revocable public path", async () => {
    const { adapter, revokeDerivative } = createAdapter();
    const service = createObjectStorageService({
      adapter,
      now: () => fixedNow,
      topology,
      uuid: () => fixedUuid,
    });
    const privateObject = await service.storePrivate({
      body: new Uint8Array([1]),
      contentType: "application/pdf",
    });
    const grant = await service.createPrivateDownload({
      authorizationGranted: true,
      object: privateObject,
    });
    const derivative = await service.storePublicDerivative({
      body: new Uint8Array([2]),
      contentType: "image/avif",
    });

    expect(grant.expiresAt).toEqual(new Date("2026-09-14T12:01:00.000Z"));
    expect(derivative.area).toBe(storageAreas.publicDerivative);
    await service.revokePublicDerivative(derivative);
    expect(revokeDerivative).toHaveBeenCalledWith({
      container: "portal-public-derivatives",
      key: derivative.key,
    });
  });

  it("rejects use of the wrong delivery path", async () => {
    const { adapter } = createAdapter();
    const service = createObjectStorageService({
      adapter,
      now: () => fixedNow,
      topology,
      uuid: () => fixedUuid,
    });
    const privateObject = await service.storePrivate({
      body: new Uint8Array([1]),
      contentType: "application/pdf",
    });
    const derivative = await service.storePublicDerivative({
      body: new Uint8Array([2]),
      contentType: "image/webp",
    });

    await expect(
      service.createPrivateDownload({
        authorizationGranted: true,
        object: derivative,
      }),
    ).rejects.toThrow(/Only private/u);
    await expect(service.revokePublicDerivative(privateObject)).rejects.toThrow(
      /Only public/u,
    );
  });
});
