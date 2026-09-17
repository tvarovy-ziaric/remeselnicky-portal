import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  compose,
  nginx,
  gitignore,
  dockerignore,
  upload,
  eicarSignature,
  alphaScript,
] = await Promise.all([
  readFile(new URL("../compose.alpha.yaml", import.meta.url), "utf8"),
  readFile(
    new URL("../infra/alpha/nginx.conf.template", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
  readFile(new URL("../packages/media/src/upload.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../infra/alpha/embedded-eicar-test.ndb", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../infra/alpha/Alpha.ps1", import.meta.url), "utf8"),
]);

const appDockerfiles = await Promise.all(
  ["api", "worker", "web"].map((name) =>
    readFile(new URL(`../apps/${name}/Dockerfile`, import.meta.url), "utf8"),
  ),
);

for (const service of [
  "postgres",
  "migrate",
  "seed",
  "minio",
  "clamav",
  "api",
  "worker",
  "web",
  "reverse-proxy",
  "cloudflared",
  "quick-app",
  "quick-object",
]) {
  assert.match(compose, new RegExp(`^  ${service}:`, "mu"));
}

assert.match(compose, /127\.0\.0\.1:\$\{ALPHA_DIAGNOSTIC_PORT:-8080\}:8080/u);
for (const forbidden of [
  /^\s+-\s+"?(?:0\.0\.0\.0:)?5432:/mu,
  /^\s+-\s+"?(?:0\.0\.0\.0:)?9000:/mu,
  /^\s+-\s+"?(?:0\.0\.0\.0:)?9001:/mu,
  /^\s+-\s+"?(?:0\.0\.0\.0:)?3310:/mu,
]) {
  assert.doesNotMatch(compose, forbidden);
}
assert.match(compose, /alpha-internal:[\s\S]*?internal: true/u);
assert.match(
  compose,
  /--token-file,[\s\r\n]*\/run\/secrets\/cloudflare_tunnel_token/u,
);
assert.match(compose, /security_opt: \[no-new-privileges:true\]/u);
assert.match(compose, /OBJECT_STORAGE_SIGNING_ENDPOINT:/u);
assert.match(nginx, /limit_except GET HEAD \{ deny all; \}/u);
assert.equal((nginx.match(/access_log off;/gu) ?? []).length, 3);
assert.match(
  nginx,
  /auth_basic_user_file \/run\/secrets\/quick_gate_htpasswd/u,
);
assert.match(nginx, /listen 8081 default_server/u);
assert.match(nginx, /listen 8082 default_server/u);
assert.match(compose, /quick-app:[\s\S]*?--url, http:\/\/reverse-proxy:8082/u);
assert.match(
  compose,
  /embedded-eicar-test\.ndb:\/run\/alpha-embedded-eicar\.ndb:ro/u,
);
assert.match(
  compose,
  /cp \/run\/alpha-embedded-eicar\.ndb \/var\/lib\/clamav\/embedded-eicar-test\.ndb/u,
);
assert.match(
  eicarSignature,
  /^Alpha\.Embedded-EICAR\.Test:0:\*:[0-9a-f]{136}\n?$/u,
);
assert.match(
  compose,
  /quick-object:[\s\S]*?--url, http:\/\/reverse-proxy:8081/u,
);
assert.match(nginx, /X-Robots-Tag "noindex, nofollow, noarchive" always/u);
assert.match(nginx, /Cache-Control "no-store" always/u);
assert.match(nginx, /portal|OBJECT_STORAGE_PRIVATE_CONTAINER/u);
assert.doesNotMatch(nginx, /9001/u);
assert.match(gitignore, /^\.alpha\/$/mu);
assert.match(gitignore, /^\.env\.\*$/mu);
assert.match(dockerignore, /^\.alpha$/mu);
assert.match(dockerignore, /^backups$/mu);
assert.match(dockerignore, /^\.env\.\*$/mu);
assert.doesNotMatch(compose, /^\s+- \.\/:\/workspace:ro$/mu);
assert.match(alphaScript, /\$previous = Get-Release/u);
assert.match(alphaScript, /\$nonce = \[guid\]::NewGuid\(\)/u);
assert.match(
  alphaScript,
  /\$next = "\$baseRevision\$worktreeMarker-\$stamp-\$nonce"/u,
);
assert.match(alphaScript, /Set-Release \$previous/u);
for (const dockerfile of appDockerfiles) {
  assert.match(
    dockerfile,
    /^COPY apps\/e2e\/package\.json apps\/e2e\/package\.json$/mu,
  );
}

const imageLimit = /const IMAGE_MAX_BYTES = (\d+) \* 1024 \* 1024/u.exec(
  upload,
);
const documentLimit = /const DOCUMENT_MAX_BYTES = (\d+) \* 1024 \* 1024/u.exec(
  upload,
);
assert.ok(imageLimit !== null && documentLimit !== null);
assert.ok(Number(imageLimit[1]) < 100);
assert.ok(Number(documentLimit[1]) < 100);

for (const forbiddenSecret of [
  /eyJ[a-zA-Z0-9_-]{40,}/u,
  /cfast_[a-zA-Z0-9]{48}/u,
  /CF-Access-Client-Secret:\s*[^<$\s]/iu,
]) {
  assert.doesNotMatch(compose + nginx, forbiddenSecret);
}

process.stdout.write("Alpha staging contract is structurally fail-closed.\n");
