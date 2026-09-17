#!/bin/sh
set -eu

tls_directory=/var/lib/postgresql/alpha-tls
install -d -m 700 -o postgres -g postgres "$tls_directory"
install -m 600 -o postgres -g postgres /run/alpha-tls/postgres.key "$tls_directory/server.key"
install -m 644 -o postgres -g postgres /run/alpha-tls/postgres.crt "$tls_directory/server.crt"
install -m 644 -o postgres -g postgres /run/alpha-tls/ca.crt "$tls_directory/ca.crt"

exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file="$tls_directory/server.crt" \
  -c ssl_key_file="$tls_directory/server.key" \
  -c ssl_ca_file="$tls_directory/ca.crt"
