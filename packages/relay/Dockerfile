FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/relay/package.json packages/relay/

RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/relay/ packages/relay/

RUN pnpm --filter @agent-town/shared build
RUN pnpm --filter @agent-town/relay build

FROM node:20-slim
WORKDIR /app
RUN corepack enable pnpm

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/relay/package.json packages/relay/
COPY --from=builder /app/packages/relay/dist packages/relay/dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/relay/node_modules packages/relay/node_modules/

EXPOSE 8787
ENV PORT=8787
CMD ["node", "packages/relay/dist/index.js"]
