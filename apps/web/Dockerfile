# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --filter @steer/web...
RUN pnpm --filter @steer/web build
EXPOSE 5173
CMD ["pnpm", "--filter", "@steer/web", "preview"]
