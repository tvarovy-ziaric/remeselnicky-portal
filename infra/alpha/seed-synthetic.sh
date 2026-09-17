#!/bin/sh
set -eu

password_file="${SYNTHETIC_SEED_PASSWORD_FILE:?SYNTHETIC_SEED_PASSWORD_FILE is required}"
if [ ! -f "$password_file" ]; then
  echo "Synthetic seed password file is unavailable" >&2
  exit 1
fi

seed_password="$(cat "$password_file")"
if [ "${#seed_password}" -lt 16 ]; then
  echo "Synthetic seed password is too short" >&2
  exit 1
fi

cd /app/apps/api
export SYNTHETIC_SEED_PASSWORD="$seed_password"
SYNTHETIC_SEED_PASSWORD_HASH="$(node -e 'const argon2=require("argon2"); const {createHmac}=require("node:crypto"); const password=process.env.SYNTHETIC_SEED_PASSWORD; const salt=createHmac("sha256",password).update("remeselnicky-alpha-synthetic-seed-v1").digest().subarray(0,16); argon2.hash(password,{type:argon2.argon2id,salt}).then((value)=>process.stdout.write(value))')"
export SYNTHETIC_SEED_PASSWORD_HASH
unset seed_password SYNTHETIC_SEED_PASSWORD
cd /app

node packages/testing/dist/seed-cli.js
node packages/db/dist/alpha-synthetic-catalog-cli.js
exec node packages/db/dist/alpha-synthetic-profiles-cli.js
