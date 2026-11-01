# syntax=docker/dockerfile:1
# VoltLink — self-hosted connected-vehicle platform.
# Multi-role single image: VL_ROLE = web | worker | scheduler | status | migrate | selftest.
# Pin by digest in CI (Dependabot bumps it): docker buildx imagetools inspect node:24-bookworm-slim.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS os
# openssl: Prisma 6 picks its engine from the detected OpenSSL.
# tini: PID 1, forwards SIGTERM, reaps children (I-IMAGEBOOT init process).
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app

# JS output is platform-independent: build once on the runner's platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV CHECKPOINT_DISABLE=1
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
COPY scripts scripts
COPY assets assets
COPY blender blender
# prisma generate -> shared -> api (tsc + esbuild + selftest bundle) -> web -> stage apps/api/web-dist
RUN npm run build

# Target platform: native argon2 prebuild + Prisma engines.
# apps/web/package.json is deliberately absent so no frontend toolchain leaks in.
FROM os AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace=@voltlink/api --include-workspace-root=false --no-audit --no-fund \
 && node node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma \
 && rm -rf node_modules/@voltlink \
 && test -f apps/api/node_modules/argon2/package.json \
 && node -e "new (require('@prisma/client').PrismaClient)()"

FROM os AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm \
           /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && groupadd --system --gid 10001 voltlink \
 && useradd --system --uid 10001 --gid voltlink --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin voltlink
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 STATUS_PORT=3001 VL_APP_ROOT=/app/apps/api
WORKDIR /app/apps/api
# Everything below is root-owned and read-only for uid 10001.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/openapi.json ./openapi.json
COPY --from=build /app/apps/api/web-dist ./web-dist
COPY --chmod=0555 docker/entrypoint.sh /usr/local/bin/voltlink-entrypoint
COPY --chmod=0555 docker/healthcheck.sh /usr/local/bin/voltlink-healthcheck
USER 10001:10001
RUN ["node", "dist/cli/selftest.cjs"]
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/usr/local/bin/voltlink-healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/voltlink-entrypoint"]
