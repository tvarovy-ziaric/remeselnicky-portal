# syntax=docker/dockerfile:1
FROM node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85

WORKDIR /app
COPY --chown=node:node infra/alpha/alpha-gate.mjs ./alpha-gate.mjs

USER node
ENV NODE_ENV=production PORT=3002
EXPOSE 3002
CMD ["node", "/app/alpha-gate.mjs"]
