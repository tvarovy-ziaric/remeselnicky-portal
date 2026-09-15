import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type {
  ObjectStorageAdapter,
  StorageArea,
  StorageObjectKey,
} from "./index.js";

const containerPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const regionPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const maximumSignedTtlSeconds = 300;

type PutInput = Parameters<ObjectStorageAdapter["put"]>[0];
type ReadPrivateInput = Parameters<ObjectStorageAdapter["readPrivate"]>[0];
type PrivateDownloadInput = Parameters<
  ObjectStorageAdapter["issuePrivateDownload"]
>[0];
type PublishDerivativeInput = Parameters<
  ObjectStorageAdapter["publishDerivative"]
>[0];
type RevokeDerivativeInput = Parameters<
  ObjectStorageAdapter["revokeDerivative"]
>[0];

export interface S3CompatibleStorageConfig {
  readonly accessKeyId: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly publicBaseUrl: string;
  readonly region: string;
  readonly secretAccessKey: string;
}

export interface S3CompatibleStorageOperations {
  delete(command: DeleteObjectCommand): Promise<void>;
  get(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  put(command: PutObjectCommand): Promise<void>;
  sign(command: GetObjectCommand, expiresIn: number): Promise<string>;
}

export function createS3CompatibleObjectStorageAdapter(
  config: S3CompatibleStorageConfig,
  dependencies: Readonly<{
    clock?: () => Date;
    operations?: S3CompatibleStorageOperations;
  }> = {},
): ObjectStorageAdapter {
  const normalized = normalizeConfig(config);
  const operations =
    dependencies.operations ?? createAwsOperations(normalized.clientConfig);
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    async put(input: PutInput) {
      assertContainer(input.container);
      assertKey(input.key, input.area);
      assertContentType(input.contentType);
      if (!(input.body instanceof Uint8Array) || input.body.byteLength === 0) {
        throw new Error("Storage upload body must be non-empty bytes");
      }
      await operations.put(
        new PutObjectCommand({
          Body: input.body,
          Bucket: input.container,
          ContentType: input.contentType,
          Key: input.key,
        }),
      );
    },

    async readPrivate(input: ReadPrivateInput) {
      assertContainer(input.container);
      assertKey(input.key, "private");
      assertMaximumBytes(input.maximumBytes);
      const output = await operations.get(
        new GetObjectCommand({
          Bucket: input.container,
          Key: input.key,
          Range: `bytes=0-${input.maximumBytes}`,
        }),
      );
      assertReportedObjectSize(output, input.maximumBytes);
      return readBoundedBody(output.Body, input.maximumBytes);
    },

    async issuePrivateDownload(input: PrivateDownloadInput) {
      assertContainer(input.container);
      assertKey(input.key, "private");
      assertContentType(input.contentType);
      assertHeaderValue(input.contentDisposition, "content disposition");
      const expiresIn = signedTtlSeconds(clock(), input.expiresAt);
      const signed = await operations.sign(
        new GetObjectCommand({
          Bucket: input.container,
          Key: input.key,
          ResponseContentDisposition: input.contentDisposition,
          ResponseContentType: input.contentType,
        }),
        expiresIn,
      );
      return assertSignedUrl(signed);
    },

    publishDerivative(input: PublishDerivativeInput) {
      assertContainer(input.container);
      assertKey(input.key, "public-derivative");
      return Promise.resolve(
        publicObjectUrl(normalized.publicBaseUrl, input.key),
      );
    },

    async revokeDerivative(input: RevokeDerivativeInput) {
      assertContainer(input.container);
      assertKey(input.key, "public-derivative");
      await operations.delete(
        new DeleteObjectCommand({
          Bucket: input.container,
          Key: input.key,
        }),
      );
    },
  });
}

function createAwsOperations(
  config: S3ClientConfig,
): S3CompatibleStorageOperations {
  const client = new S3Client(config);
  return Object.freeze({
    async delete(command: DeleteObjectCommand): Promise<void> {
      await client.send(command);
    },
    get(command: GetObjectCommand): Promise<GetObjectCommandOutput> {
      return client.send(command);
    },
    async put(command: PutObjectCommand): Promise<void> {
      await client.send(command);
    },
    sign(command: GetObjectCommand, expiresIn: number): Promise<string> {
      return getSignedUrl(client, command, { expiresIn });
    },
  });
}

function normalizeConfig(config: S3CompatibleStorageConfig): Readonly<{
  clientConfig: S3ClientConfig;
  publicBaseUrl: URL;
}> {
  const region = config.region.trim().toLowerCase();
  if (!regionPattern.test(region)) throw new Error("Storage region is invalid");
  const accessKeyId = boundedSecret(config.accessKeyId, "access key", 256);
  const secretAccessKey = boundedSecret(
    config.secretAccessKey,
    "secret access key",
    1_024,
  );
  const endpointUrl =
    config.endpoint === undefined
      ? undefined
      : safeServiceUrl(config.endpoint, "storage endpoint");
  if (
    endpointUrl !== undefined &&
    (endpointUrl.search !== "" || endpointUrl.hash !== "")
  ) {
    throw new Error("Storage endpoint cannot contain query or fragment");
  }
  const endpoint = endpointUrl?.toString();
  const publicBaseUrl = safeServiceUrl(
    config.publicBaseUrl,
    "public storage base URL",
  );
  if (publicBaseUrl.search !== "" || publicBaseUrl.hash !== "") {
    throw new Error("Public storage base URL cannot contain query or fragment");
  }
  return Object.freeze({
    clientConfig: {
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint === undefined ? {} : { endpoint }),
      forcePathStyle: config.forcePathStyle ?? false,
      region,
    },
    publicBaseUrl,
  });
}

function boundedSecret(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Storage ${label} is invalid`);
  }
  return value;
}

function safeServiceUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`${label} is invalid`);
  }
  return url;
}

function assertContainer(container: string): void {
  if (
    !containerPattern.test(container) ||
    container.includes("..") ||
    container.includes(".-") ||
    container.includes("-.")
  ) {
    throw new Error("Storage container is invalid");
  }
}

function assertKey(key: StorageObjectKey, area: StorageArea): void {
  const pattern = new RegExp(
    `^${area}/\\d{4}/(?:0[1-9]|1[0-2])/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "iu",
  );
  if (!pattern.test(key)) throw new Error("Storage object key is invalid");
}

function assertContentType(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
  ) {
    throw new Error("Storage content type is invalid");
  }
}

function assertHeaderValue(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error(`Storage ${label} is invalid`);
  }
}

function assertMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Storage read limit is invalid");
  }
}

function assertReportedObjectSize(
  output: GetObjectCommandOutput,
  maximumBytes: number,
): void {
  if (
    output.ContentLength !== undefined &&
    (!Number.isSafeInteger(output.ContentLength) ||
      output.ContentLength > maximumBytes)
  ) {
    throw new Error("Private object exceeds the processing byte limit");
  }
  if (output.ContentRange !== undefined) {
    const match = /^bytes \d+-\d+\/(\d+|\*)$/u.exec(output.ContentRange);
    if (match === null)
      throw new Error("Storage returned an invalid byte range");
    const total = match[1];
    if (total === "*" || Number(total) > maximumBytes) {
      throw new Error("Private object exceeds the processing byte limit");
    }
  }
}

async function readBoundedBody(
  body: GetObjectCommandOutput["Body"],
  maximumBytes: number,
): Promise<Uint8Array> {
  if (body === undefined || !isAsyncIterable(body)) {
    throw new Error("Storage returned an unreadable private object");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const rawChunk of body) {
    const chunk = toBytes(rawChunk);
    byteLength += chunk.byteLength;
    if (byteLength > maximumBytes) {
      throw new Error("Private object exceeds the processing byte limit");
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("Storage returned an invalid private object chunk");
}

function signedTtlSeconds(now: Date, expiresAt: Date): number {
  if (
    !Number.isFinite(now.valueOf()) ||
    !Number.isFinite(expiresAt.valueOf())
  ) {
    throw new Error("Storage download expiry is invalid");
  }
  const expiresIn = Math.floor((expiresAt.valueOf() - now.valueOf()) / 1_000);
  if (expiresIn < 1 || expiresIn > maximumSignedTtlSeconds) {
    throw new Error("Storage download expiry is outside the allowed window");
  }
  return expiresIn;
}

function assertSignedUrl(value: string): URL {
  const url = safeServiceUrl(value, "signed download URL");
  if (url.protocol !== "https:" || url.hash !== "") {
    throw new Error("Signed download URL is invalid");
  }
  return url;
}

function publicObjectUrl(baseUrl: URL, key: StorageObjectKey): URL {
  const normalizedBase = new URL(baseUrl.toString());
  if (!normalizedBase.pathname.endsWith("/")) normalizedBase.pathname += "/";
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return new URL(encodedKey, normalizedBase);
}
