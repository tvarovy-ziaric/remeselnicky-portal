import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const requireStorageDependency = createRequire(
  new URL("../../packages/storage/package.json", import.meta.url),
);
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } =
  requireStorageDependency("@aws-sdk/client-s3");
const { getSignedUrl } = requireStorageDependency(
  "@aws-sdk/s3-request-presigner",
);

const credentials = {
  accessKeyId: (await readFile("/run/secrets/minio_access_key", "utf8")).trim(),
  secretAccessKey: (
    await readFile("/run/secrets/minio_secret_key", "utf8")
  ).trim(),
};
const bucket = process.env.OBJECT_STORAGE_PRIVATE_CONTAINER;
const hostname = process.env.ALPHA_OBJECT_HOSTNAME;
const region = process.env.OBJECT_STORAGE_REGION;
if (!bucket || !hostname?.endsWith(".trycloudflare.com") || !region) {
  throw new Error("Quick object probe configuration is incomplete");
}

const now = new Date();
const key = `private/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
const body = `synthetic-quick-object-probe:${randomUUID()}`;
const clientConfig = { credentials, forcePathStyle: true, region };
const privateClient = new S3Client({
  ...clientConfig,
  endpoint: "https://minio:9000",
});
const signingClient = new S3Client({
  ...clientConfig,
  endpoint: `https://${hostname}`,
});

try {
  await privateClient.send(
    new PutObjectCommand({
      Body: body,
      Bucket: bucket,
      ContentType: "text/plain",
      Key: key,
    }),
  );
  const signedUrl = await getSignedUrl(
    signingClient,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: 'attachment; filename="probe.txt"',
      ResponseContentType: "text/plain",
    }),
    { expiresIn: 60 },
  );
  const response = await fetch(signedUrl, { redirect: "error" });
  if (response.status !== 200) {
    throw new Error(`Signed object HTTP status ${response.status}`);
  }
  if ((await response.text()) !== body) {
    throw new Error("Signed object body mismatch");
  }
  process.stdout.write("Quick Tunnel signed-object roundtrip passed.\n");
} catch (error) {
  process.stderr.write(
    `Quick Tunnel signed-object roundtrip failed: ${error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[redacted URL]") : "unknown error"}\n`,
  );
  process.exitCode = 1;
} finally {
  await privateClient.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
  privateClient.destroy();
  signingClient.destroy();
}
