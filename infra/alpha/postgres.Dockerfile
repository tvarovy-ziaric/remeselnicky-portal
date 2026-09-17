FROM postgis/postgis:17-3.5-alpine

COPY infra/alpha/postgres-entrypoint.sh /usr/local/bin/alpha-postgres-entrypoint
RUN chmod 0755 /usr/local/bin/alpha-postgres-entrypoint

ENTRYPOINT ["/usr/local/bin/alpha-postgres-entrypoint"]
