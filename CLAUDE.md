# CLAUDE.md


Stack: Typescript, Vite, React, TanStack, Self-Rolled Auth, Vercel AI SDK

Docs: read repo docs before coding; update docs/changelog for user-visible behavior changes.

Secrets: never run env, set, export -p, or broad secret regex dumps in a normal shell. Query exact names only; redact values.

- do not check any environment variable ".env" ".env*" "secrets" "env/" file or folder ever.
- create unit tests for every bug, fix, feature
- create an evaluation test for every user-facing agent call with golden sets.
- do not accept smoke tests as "test driven development". TDD requires one of unit, integration, e2e tests.
- do not use inference for test outputs, use database fetches/results
- ground every code change in a concrete customer/user outcome — name the user-visible behavior it improves before implementing; if a change can't be traced to one, reconsider it.
- code is the source of truth, NOT documentation. Diagnose real behavior by reading/running the actual code, never by trusting docs, plans, comments, or assumptions. When code and docs disagree, the code wins — then fix the docs.

# Product requirements (source: take-home PRD, /tmp/steer-prd/PRD.md)

THIS IS BUILT FOR EXTERNAL PEOPLE on their OWN machines — a technical reviewer and end users, not this dev. Every default must work for a stranger who just cloned the repo. Never retrofit defaults to this machine's paths/dirs, and never make `docker compose up` depend on host-specific configuration.

## The reject-the-submission constraint (most important)
A reviewer MUST be able to put API keys in a `.env` file and run `docker compose up` to BUILD AND RUN the whole project — with **no additional build steps and no additional configuration**. No Docker Desktop file-sharing changes, no host mounts the user has to set up, no extra commands. If getting it running needs anything beyond a `.env` key, it is wrong and will be rejected.

## docker-compose MUST contain 4 things
- server process + UI (same or separate containers) — expose ports for the user to interact.
- Postgres database.
- Electric SQL container.
- a SEPARATE container the coding agent runs INSIDE and connects OUT from. This agent container MUST NOT expose or open any ports.

## System shape
- Server: web API + sync-driven UI.
- Postgres + Electric SQL: persistence + postgres-based sync.
- Headless agent/daemon: runs ANYWHERE that can connect out (workstation, sandbox, container); contains the agent loop (inference calls, state); **starting it must be as simple as running a CLI command**; receives tasks via Electric sync; runs sessions on the host it runs on (for the container, that = the container); sends events (tool calls, thinking, messages) back to the server.
- UI: reactive; ALL collections (sessions, events) synced via Electric SQL + TanStack DB; running sessions stream live; users login/logout, list/navigate, create/delete, interrupt + continue, rename + delete.

## Tech constraints
- 100% TypeScript, frontend AND agent/backend.
- Real auth + authz boundary (proper request authorization).
- Sync MUST use Electric SQL + TanStack DB + Postgres.
- MUST NOT use: a coding-agent SDK (Claude Code / OpenCode / Amp / Cursor SDKs, binaries, or source) as the agent; Next.js; non-postgres DBs; websockets. (LLM-provider SDKs and agent-building SDKs like Vercel AI SDK / Mastra / Langchain ARE allowed.)
- MAY require the end-user to set an LLM provider API key (Anthropic/OpenAI/Google) in `.env`; provide config instructions. All work tracked in git; README must get a reviewer running + link a demo video.

## What this means for design
The agent runs in ITS container on ITS filesystem by default — "the host it's running on" is the container. Operating on the USER'S laptop files is NOT a PRD requirement and MUST NOT become a precondition for `docker compose up`. Any "run on your real files" path must be OPTIONAL (a local daemon the user chooses to start, or an opt-in `WORKSPACE_DIR` mount of a dir Docker already shares) — never required, never needing host config. Do not end a turn on a failing/abandoned state.

