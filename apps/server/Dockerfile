# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache curl
WORKDIR /app
# Whole workspace context (see .dockerignore for exclusions) so pnpm can
# resolve workspace packages; the filter keeps only what the server needs.
COPY . .
RUN pnpm install --frozen-lockfile --filter @steer/server...

# One-shot migration container.
FROM base AS migrate
CMD ["pnpm", "--filter", "@steer/server", "migrate"]

# Long-running API server.
FROM base AS runtime
EXPOSE 8080
CMD ["pnpm", "--filter", "@steer/server", "serve"]
