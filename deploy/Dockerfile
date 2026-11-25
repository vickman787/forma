FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 FFMPEG_BIN=/usr/bin/ffmpeg FFMPEG_PATH=/usr/bin/ffmpeg

FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
ENV FORMA_STANDALONE=true
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 LISTEN_HOST=0.0.0.0 ESCROW_DEPLOYMENT_RECORD=/app/deploy/escrow-mainnet.json OPERATOR_RECORD_DIRECTORY=/data/live/operator
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --chown=node:node lib ./lib
COPY --chown=node:node worker ./worker
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node scripts/operator-preflight.ts scripts/operator-execute.ts scripts/operator-reconcile.ts scripts/worker-healthcheck.ts ./scripts/
COPY --chown=node:node deploy/escrow-mainnet.json ./deploy/
RUN mkdir -p /data/live /app/.forma/contracts && chown -R node:node /data /app/.forma
USER node
EXPOSE 3000 4317
CMD ["node", "server.js"]
