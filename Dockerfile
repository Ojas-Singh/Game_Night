# ---- RuleZero python deps: Game Lab solver/gallery service (S6) ----
# open-spiel ships manylinux wheels; must live under a glibc base.
FROM python:3.13-slim AS rzdeps
RUN python -m venv /opt/rzven \
 && /opt/rzven/bin/pip install --no-cache-dir open-spiel==2.0.2

# ---- Build stage: workspace packages + web client ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine-cabo/package.json packages/engine-cabo/
COPY packages/engine-pairone/package.json packages/engine-pairone/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/agent-bots/package.json packages/agent-bots/
COPY packages/agent-llm/package.json packages/agent-llm/
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @game-night/shared build \
  && pnpm --filter @game-night/engine-cabo build \
  && pnpm --filter @game-night/engine-pairone build \
  && pnpm --filter @game-night/agent-core build \
  && pnpm --filter @game-night/agent-bots build \
  && pnpm --filter @game-night/agent-llm build \
  && pnpm --filter @game-night/web build \
  && pnpm --filter @game-night/server build

# ---- Runtime stage ----
# Debian (glibc) base so the RuleZero python venv above can run; Alpine's
# musl cannot load manylinux wheels.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV RULEZERO_HOME=/app/research/rulezero
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine-cabo/package.json packages/engine-cabo/
COPY packages/engine-pairone/package.json packages/engine-pairone/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/agent-bots/package.json packages/agent-bots/
COPY packages/agent-llm/package.json packages/agent-llm/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/engine-cabo/dist packages/engine-cabo/dist/
COPY --from=build /app/packages/engine-pairone/dist packages/engine-pairone/dist/
COPY --from=build /app/packages/agent-core/dist packages/agent-core/dist/
COPY --from=build /app/packages/agent-bots/dist packages/agent-bots/dist/
COPY --from=build /app/packages/agent-llm/dist packages/agent-llm/dist/
COPY --from=build /app/apps/server/dist apps/server/dist/
COPY --from=build /app/apps/web/dist apps/server/web/

# RuleZero service: code + prebuilt venv (Game Lab routes spawn it)
COPY research/rulezero/pyproject.toml research/rulezero/pyproject.toml
COPY research/rulezero/rulezero research/rulezero/rulezero
COPY --from=rzdeps /opt/rzven research/rulezero/.venv
# writable dirs for solver-policy cache + shared-spec records
RUN mkdir -p research/rulezero/cache/policies research/rulezero/reports/shared \
 && chown -R node:node research/rulezero/cache research/rulezero/reports
EXPOSE 3000
USER node
CMD ["node", "apps/server/dist/index.js"]
