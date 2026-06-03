# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --filter @steer/web...

# Vite inlines VITE_* at build time, so they must be present as build args
# (the compose `environment:` block is runtime-only).
ARG VITE_WORKOS_CLIENT_ID
ARG VITE_WORKOS_REDIRECT_URI
ARG VITE_SERVER_URL
ENV VITE_WORKOS_CLIENT_ID=$VITE_WORKOS_CLIENT_ID \
    VITE_WORKOS_REDIRECT_URI=$VITE_WORKOS_REDIRECT_URI \
    VITE_SERVER_URL=$VITE_SERVER_URL

RUN pnpm --filter @steer/web build
EXPOSE 5173
CMD ["pnpm", "--filter", "@steer/web", "preview"]
