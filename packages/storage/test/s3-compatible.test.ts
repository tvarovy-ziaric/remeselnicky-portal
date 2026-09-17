import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  createS3CompatibleObjectStorageAdapter,
  createStorageObjectKey,
  type S3CompatibleStorageOperations,
} from "../src/index.js";

const privateKey = createStorageObjectKey("private", {
  now: () => new Date("2026-09-15T00:00:00.000Z"),
  uuid: () => "11111111-1111-4111-8111-111111111111",
});
const publicKey = createStorageObjectKey("public-derivative", {
  now: () => new Date("2026-09-15T00:00:00.000Z"),
  uuid: () => "22222222-2222-4222-8222-222222222222",
});

describe("S3-compatible object storage adapter", () => {
  it("authors bounded private writes and reads through opaque keys", async () => {
    const fixture = operations({
      Body: asyncBody([new Uint8Array([1]), new Uint8Array([2, 3])]),
      ContentLength: 3,
      ContentRange: "bytes 0-2/3",
      $metadata: {},
    });
    const adapter = createAdapter(fixture.value);

    await adapter.put({
      area: "private",
      body: new Uint8Array([1, 2, 3]),
      container: "portal-private",
      contentType: "application/pdf",
      key: privateKey,
    });
    await expect(
      adapter.readPrivate({
        container: "portal-private",
        key: privateKey,
        maximumBytes: 3,
      }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(fixture.put).toHaveBeenCalledOnce();
    expect(fixture.put.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "portal-private",
      ContentType: "application/pdf",
      Key: privateKey,
    });
    expect(fixture.get.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "portal-private",
      Key: privateKey,
      Range: "bytes=0-3",
    });
  });

  it("stops a private read when the provider returns more than the bound", async () => {
    const fixture = operations({
      Body: asyncBody([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      $metadata: {},
    });
    const adapter = createAdapter(fixture.value);

    await expect(
      adapter.readPrivate({
        container: "portal-private",
        key: privateKey,
        maximumBytes: 3,
      }),
    ).rejects.toThrow(/exceeds/u);
  });

  it("rejects an oversized provider range before consuming its body", async () => {
    let consumed = false;
    const fixture = operations({
      Body: asyncBody([new Uint8Array([1])], () => {
        consumed = true;
      }),
      ContentLength: 1,
      ContentRange: "bytes 0-0/4",
      $metadata: {},
    });
    const adapter = createAdapter(fixture.value);

    await expect(
      adapter.readPrivate({
        container: "portal-private",
        key: privateKey,
        maximumBytes: 3,
      }),
    ).rejects.toThrow(/exceeds/u);
    expect(consumed).toBe(false);
  });

  it("fails closed when range metadata cannot prove the total size", async () => {
    const fixture = operations({
      Body: asyncBody([new Uint8Array([1])]),
      ContentLength: 1,
      ContentRange: "bytes 0-0/*",
      $metadata: {},
    });
    const adapter = createAdapter(fixture.value);

    await expect(
      adapter.readPrivate({
        container: "portal-private",
        key: privateKey,
        maximumBytes: 3,
      }),
    ).rejects.toThrow(/exceeds/u);
  });

  it("binds a short private grant to content headers and exact expiry", async () => {
    const fixture = operations();
    fixture.sign.mockResolvedValue(
      "https://objects.example/private/key?X-Amz-Signature=opaque",
    );
    const adapter = createAdapter(fixture.value);

    await expect(
      adapter.issuePrivateDownload({
        container: "portal-private",
        contentDisposition: 'attachment; filename="portal-document.pdf"',
        contentType: "application/pdf",
        expiresAt: new Date("2026-09-15T00:00:45.000Z"),
        key: privateKey,
      }),
    ).resolves.toEqual(
      new URL("https://objects.example/private/key?X-Amz-Signature=opaque"),
    );

    expect(fixture.sign).toHaveBeenCalledOnce();
    expect(fixture.sign.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "portal-private",
      Key: privateKey,
      ResponseContentDisposition: 'attachment; filename="portal-document.pdf"',
      ResponseContentType: "application/pdf",
    });
    expect(fixture.sign.mock.calls[0]?.[1]).toBe(45);
  });

  it("publishes only public derivatives and revokes the exact object", async () => {
    const fixture = operations();
    const adapter = createAdapter(fixture.value);

    await expect(
      adapter.publishDerivative({
        container: "portal-public",
        key: publicKey,
      }),
    ).resolves.toEqual(
      new URL(
        "https://cdn.example/assets/public-derivative/2026/09/22222222-2222-4222-8222-222222222222",
      ),
    );
    await adapter.revokeDerivative({
      container: "portal-public",
      key: publicKey,
    });

    expect(fixture.delete.mock.calls[0]?.[0].input).toEqual({
      Bucket: "portal-public",
      Key: publicKey,
    });
    expect(() =>
      adapter.publishDerivative({
        container: "portal-public",
        key: privateKey,
      }),
    ).toThrow(/key/u);
  });

  it("rejects credential-bearing or malformed service configuration", () => {
    expect(() =>
      createS3CompatibleObjectStorageAdapter({
        accessKeyId: "access",
        publicBaseUrl: "https://user:secret@cdn.example/assets/",
        region: "eu-central-1",
        secretAccessKey: "secret",
      }),
    ).toThrow(/base URL/u);
    expect(() =>
      createS3CompatibleObjectStorageAdapter({
        accessKeyId: "access",
        endpoint: "ftp://objects.example",
        publicBaseUrl: "https://cdn.example/assets/",
        region: "eu-central-1",
        secretAccessKey: "secret",
      }),
    ).toThrow(/endpoint/u);
    expect(() =>
      createS3CompatibleObjectStorageAdapter({
        accessKeyId: "access",
        endpoint: "https://objects.internal",
        publicBaseUrl: "https://cdn.example/assets/",
        region: "eu-central-1",
        secretAccessKey: "secret",
        signingEndpoint: "https://user:secret@objects.example",
      }),
    ).toThrow(/signing endpoint/u);
  });

  it("mints downloads against a distinct public signing endpoint", async () => {
    const adapter = createS3CompatibleObjectStorageAdapter(
      {
        accessKeyId: "access-key",
        endpoint: "https://minio.internal:9000",
        forcePathStyle: true,
        publicBaseUrl: "https://objects-alpha.example/public/",
        region: "eu-central-1",
        secretAccessKey: "secret-key",
        signingEndpoint: "https://objects-alpha.example",
      },
      { clock: () => new Date("2026-09-15T00:00:00.000Z") },
    );

    const url = await adapter.issuePrivateDownload({
      container: "portal-private",
      contentDisposition: 'attachment; filename="portal-document.pdf"',
      contentType: "application/pdf",
      expiresAt: new Date("2026-09-15T00:00:45.000Z"),
      key: privateKey,
    });

    expect(url.origin).toBe("https://objects-alpha.example");
    expect(url.pathname).toContain("/portal-private/private/");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
  });
});

function createAdapter(operationsValue: S3CompatibleStorageOperations) {
  return createS3CompatibleObjectStorageAdapter(
    {
      accessKeyId: "access-key",
      endpoint: "https://objects.example",
      forcePathStyle: true,
      publicBaseUrl: "https://cdn.example/assets/",
      region: "eu-central-1",
      secretAccessKey: "secret-key",
    },
    {
      clock: () => new Date("2026-09-15T00:00:00.000Z"),
      operations: operationsValue,
    },
  );
}

function operations(getOutput?: GetObjectCommandOutput) {
  const deleteObject = vi.fn<S3CompatibleStorageOperations["delete"]>(() =>
    Promise.resolve(),
  );
  const get = vi.fn<S3CompatibleStorageOperations["get"]>(() =>
    getOutput === undefined
      ? Promise.reject(new Error("unexpected get"))
      : Promise.resolve(getOutput),
  );
  const put = vi.fn<S3CompatibleStorageOperations["put"]>(() =>
    Promise.resolve(),
  );
  const sign = vi.fn<S3CompatibleStorageOperations["sign"]>(() =>
    Promise.reject(new Error("unexpected sign")),
  );
  return {
    delete: deleteObject,
    get,
    put,
    sign,
    value: Object.freeze({ delete: deleteObject, get, put, sign }),
  };
}

function asyncBody(
  chunks: readonly Uint8Array[],
  onStart?: () => void,
): Exclude<GetObjectCommandOutput["Body"], undefined> {
  return (async function* stream() {
    await Promise.resolve();
    onStart?.();
    for (const chunk of chunks) yield chunk;
  })() as unknown as Exclude<GetObjectCommandOutput["Body"], undefined>;
}
