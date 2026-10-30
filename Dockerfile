# syntax=docker/dockerfile:1
# VoltLink — self-hosted connected-vehicle platform.
# Multi-role single image: VL_ROLE = web | worker | scheduler | status.

# ---------------------------------------------------------------- build stage
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Install workspace manifests first for layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# Sources.
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web

# Prisma client + engines (schema arrives with sources, after npm ci).
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# Build: shared contracts → API bundle (.cjs) → SPA → stage SPA for the API.
RUN npm run build \
  && mkdir -p apps/api/web-dist \
  && cp -r apps/web/dist/* apps/api/web-dist/

# Keep production deps only (prisma CLI is a runtime dep for migrate deploy).
# A fresh prod-only `npm ci` is deterministic — unlike `prune`, it cannot leave
# hoisted dev dependencies (e.g. jsdom's undici) in the final image.
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime stage
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="VoltLink" \
      org.opencontainers.image.description="Self-hosted connected-vehicle platform" \
      org.opencontainers.image.source="https://github.com/Atvriders/voltlink" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN groupadd --system voltlink && useradd --system --gid voltlink --no-create-home --home-dir /app voltlink

WORKDIR /app/apps/api

COPY --from=build --chown=voltlink:voltlink /app/node_modules /app/node_modules
COPY --from=build --chown=voltlink:voltlink /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build --chown=voltlink:voltlink /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build --chown=voltlink:voltlink /app/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=voltlink:voltlink /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build --chown=voltlink:voltlink /app/apps/api/web-dist /app/apps/api/web-dist
COPY --from=build --chown=voltlink:voltlink /app/apps/api/openapi.json /app/apps/api/openapi.json
COPY --chown=voltlink:voltlink docker/entrypoint.sh /usr/local/bin/voltlink-entrypoint
COPY --chown=voltlink:voltlink docker/healthcheck.sh /usr/local/bin/voltlink-healthcheck

RUN chmod +x /usr/local/bin/voltlink-entrypoint /usr/local/bin/voltlink-healthcheck

USER voltlink
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["/usr/local/bin/voltlink-healthcheck"]

ENTRYPOINT ["voltlink-entrypoint"]
CMD ["web"]
