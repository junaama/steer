# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
RUN npm install -g typescript-language-server typescript
WORKDIR /app
COPY . .
RUN pnpm install --filter @steer/agent...
# PORTLESS: no EXPOSE, no published ports — connects outbound only.
CMD ["pnpm", "--filter", "@steer/agent", "serve"]
