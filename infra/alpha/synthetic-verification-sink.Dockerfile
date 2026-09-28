FROM node:24.8.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node infra/alpha/synthetic-verification-sink.mjs ./sink.mjs
RUN mkdir -p /var/lib/synthetic-verification \
  && chown node:node /var/lib/synthetic-verification \
  && chmod 0700 /var/lib/synthetic-verification
USER node
EXPOSE 8467
CMD ["node", "--no-warnings", "/app/sink.mjs"]
