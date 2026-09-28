import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const port = 8467;
const ttlMs = 10 * 60 * 1_000;
const maxBodyBytes = 4_096;
const maxRows = 1_000;
const databasePath =
  process.env.SYNTHETIC_VERIFICATION_DATABASE_PATH ??
  "/var/lib/synthetic-verification/sink.sqlite";
const ingestKey = readHexTextSecret("SYNTHETIC_VERIFICATION_INGEST_KEY_FILE");
const claimKey = readHexTextSecret("SYNTHETIC_VERIFICATION_CLAIM_KEY_FILE");
const encryptionKey = Buffer.from(
  readHexTextSecret("SYNTHETIC_VERIFICATION_ENCRYPTION_KEY_FILE"),
  "hex",
);
const indexKey = createHmac("sha256", encryptionKey)
  .update("portal-synthetic-verification-index-v1", "utf8")
  .digest();

const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS deliveries (
    channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'PHONE')),
    destination_hash TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (channel, destination_hash)
  ) STRICT;
`);
purgeExpired();

const insertDelivery = database.prepare(`
  INSERT INTO deliveries (
    channel, destination_hash, ciphertext, iv, auth_tag,
    created_at_ms, expires_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (channel, destination_hash) DO UPDATE SET
    ciphertext = excluded.ciphertext,
    iv = excluded.iv,
    auth_tag = excluded.auth_tag,
    created_at_ms = excluded.created_at_ms,
    expires_at_ms = excluded.expires_at_ms
`);
const findDelivery = database.prepare(`
  SELECT ciphertext, iv, auth_tag, expires_at_ms
  FROM deliveries
  WHERE channel = ? AND destination_hash = ?
`);
const deleteDelivery = database.prepare(`
  DELETE FROM deliveries WHERE channel = ? AND destination_hash = ?
`);
const countDeliveries = database.prepare(
  "SELECT count(*) AS count FROM deliveries",
);

const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.method === "GET" && request.url === "/health/ready") {
    try {
      database.prepare("SELECT 1 AS ready").get();
      respond(response, 200, { ready: true });
    } catch {
      respond(response, 503, { ready: false });
    }
    return;
  }
  if (request.method !== "POST") {
    respond(response, 404, { code: "NOT_FOUND" });
    return;
  }

  const expectedKey = request.url === "/v1/deliver" ? ingestKey : claimKey;
  if (request.url !== "/v1/deliver" && request.url !== "/v1/claim") {
    respond(response, 404, { code: "NOT_FOUND" });
    return;
  }
  if (!authorized(request.headers.authorization, expectedKey)) {
    respond(response, 401, { code: "UNAUTHORIZED" });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    respond(response, 400, { code: "INVALID_REQUEST" });
    return;
  }

  if (request.url === "/v1/deliver") {
    if (!validDelivery(body)) {
      respond(response, 400, { code: "INVALID_REQUEST" });
      return;
    }
    purgeExpired();
    const hash = destinationHash(body.channel, body.destination);
    const rowCount = Number(countDeliveries.get().count);
    if (
      rowCount >= maxRows &&
      findDelivery.get(body.channel, hash) === undefined
    ) {
      respond(response, 503, { code: "CAPACITY_REACHED" });
      return;
    }
    const encrypted = encrypt(body.secret);
    const now = Date.now();
    insertDelivery.run(
      body.channel,
      hash,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      now,
      now + ttlMs,
    );
    respond(response, 202, { accepted: true });
    return;
  }

  if (!validClaim(body)) {
    respond(response, 400, { code: "INVALID_REQUEST" });
    return;
  }
  const hash = destinationHash(body.channel, body.destination);
  let secret;
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = findDelivery.get(body.channel, hash);
    if (row !== undefined && Number(row.expires_at_ms) > Date.now()) {
      secret = decrypt(row);
      deleteDelivery.run(body.channel, hash);
    } else if (row !== undefined) {
      deleteDelivery.run(body.channel, hash);
    }
    database.exec("COMMIT");
  } catch {
    database.exec("ROLLBACK");
    respond(response, 500, { code: "UNAVAILABLE" });
    return;
  }
  if (secret === undefined) {
    respond(response, 404, { code: "NOT_FOUND" });
    return;
  }
  respond(response, 200, { secret });
});

server.listen(port, "0.0.0.0", () => {
  console.log("synthetic verification sink ready");
});

function readHexTextSecret(variableName) {
  const path = process.env[variableName];
  if (path === undefined) throw new Error(`${variableName} is required`);
  const value = readFileSync(path, "utf8");
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${variableName} contains invalid secret material`);
  }
  return value;
}

function authorized(header, expected) {
  const prefix = "Bearer ";
  if (typeof header !== "string" || !header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function validDestination(channel, destination) {
  return channel === "EMAIL"
    ? /^synthetic\.e2e\.[a-f0-9]{32}\.[a-f0-9]{32}@portal\.invalid$/u.test(
        destination,
      )
    : /^\+999[0-9]{8,12}$/u.test(destination);
}

function validClaim(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    (body.channel === "EMAIL" || body.channel === "PHONE") &&
    typeof body.destination === "string" &&
    Object.keys(body).length === 2 &&
    validDestination(body.channel, body.destination)
  );
}

function validDelivery(body) {
  const validSecret =
    body?.channel === "EMAIL"
      ? typeof body.secret === "string" &&
        /^[A-Za-z0-9_-]{32,128}$/u.test(body.secret)
      : typeof body?.secret === "string" && /^[0-9]{6}$/u.test(body.secret);
  return (
    validClaim({ channel: body?.channel, destination: body?.destination }) &&
    validSecret &&
    Object.keys(body).length === 3
  );
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("oversized");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function destinationHash(channel, destination) {
  return createHmac("sha256", indexKey)
    .update(`${channel}\0${destination}`, "utf8")
    .digest("hex");
}

function encrypt(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return { authTag: cipher.getAuthTag(), ciphertext, iv };
}

function decrypt(row) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, row.iv);
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([
    decipher.update(row.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function purgeExpired() {
  database
    .prepare("DELETE FROM deliveries WHERE expires_at_ms <= ?")
    .run(Date.now());
}

function respond(response, statusCode, body) {
  response.writeHead(statusCode);
  response.end(JSON.stringify(body));
}
