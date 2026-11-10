# ---- Rules core: the Rust games compiled to WebAssembly ----
FROM rust:1-alpine AS wasm
RUN apk add --no-cache musl-dev \
 && rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.127 --locked
WORKDIR /app/core
COPY core .
RUN cargo build --release -p gamelab-wasm --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --out-dir /app/pkg target/wasm32-unknown-unknown/release/gamelab_wasm.wasm

# ---- Build stage: workspace packages + web client ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/engine-cabo/package.json packages/engine-cabo/
COPY packages/engine-pairone/package.json packages/engine-pairone/
COPY packages/engine-seep/package.json packages/engine-seep/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/agent-bots/package.json packages/agent-bots/
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY --from=wasm /app/pkg packages/core/pkg/
RUN pnpm --filter @game-night/shared build \
  && pnpm --filter @game-night/core build \
  && pnpm --filter @game-night/engine-cabo build \
  && pnpm --filter @game-night/engine-pairone build \
  && pnpm --filter @game-night/engine-seep build \
  && pnpm --filter @game-night/agent-core build \
  && pnpm --filter @game-night/agent-bots build \
  && pnpm --filter @game-night/web build \
  && pnpm --filter @game-night/server build

# ---- Runtime stage ----
# Debian, not Alpine: the model seat's onnxruntime-node needs glibc.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/engine-cabo/package.json packages/engine-cabo/
COPY packages/engine-pairone/package.json packages/engine-pairone/
COPY packages/engine-seep/package.json packages/engine-seep/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/agent-bots/package.json packages/agent-bots/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod \
 && pnpm store prune && rm -rf /root/.cache /root/.npm
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/core/dist packages/core/dist/
COPY --from=build /app/packages/core/pkg packages/core/pkg/
COPY --from=build /app/packages/engine-cabo/dist packages/engine-cabo/dist/
COPY --from=build /app/packages/engine-pairone/dist packages/engine-pairone/dist/
COPY --from=build /app/packages/engine-seep/dist packages/engine-seep/dist/
COPY --from=build /app/packages/agent-core/dist packages/agent-core/dist/
COPY --from=build /app/packages/agent-bots/dist packages/agent-bots/dist/
COPY --from=build /app/apps/server/dist apps/server/dist/
COPY --from=build /app/apps/web/dist apps/server/web/

EXPOSE 3000
USER node
CMD ["node", "apps/server/dist/index.js"]
