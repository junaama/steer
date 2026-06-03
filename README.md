# Steer

A **sync-based headless coding agent** with a reactive web UI — and the ability to **steer it live**. Watch the agent work in real time, and reach into a running tool call to **swap, edit, or approve** it: cancel a wasteful `grep` mid-flight and substitute a `read`, or gate a `write_file` behind approval — without restarting the run or re-planning.

Built on the principle that **Postgres is the single source of truth** and the UI and agent are pure projections of synced state through **Electric SQL + TanStack DB** — never a websocket, never local state pretending to be live.

---

## Quick start

**Prerequisites:** Docker, an **OpenAI or Anthropic API key** (for the agent), and a WorkOS AuthKit project (for login).

```bash
git clone <this-repo> steer && cd steer
cp .env.example .env        # fill in WORKOS_* and ANTHROPIC_API_KEY
docker compose up --build   # builds + starts the whole stack
```

Then open **http://localhost:5173**, sign in, and create a session.

> **No extra build steps.** `docker compose up` brings up Postgres, Electric, the
> server/UI, and the (portless) agent. The first boot builds images and runs DB
> migrations automatically before the app starts.

**Optional — seed a demo session:** `docker compose exec server pnpm seed`
(set `SEED_USER_ID` to your WorkOS user id to see it after login).

### Configuration (`.env`)

| Var | Purpose |
|---|---|
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | server-side WorkOS auth |
| `VITE_WORKOS_CLIENT_ID`, `VITE_WORKOS_REDIRECT_URI` | browser AuthKit (set the redirect to `http://localhost:5173/callback` and register it in the WorkOS dashboard) |
| `OPENAI_API_KEY` *or* `ANTHROPIC_API_KEY` | the coding agent's model. Provider is auto-detected (OpenAI preferred when both set) or pinned with `LLM_PROVIDER=openai\|anthropic`; override the model with `OPENAI_MODEL` / `ANTHROPIC_MODEL` |
| `DATABASE_URL` | defaults to the local Postgres container; point it at a [Neon](https://neon.tech) connection string for a hosted database |

---

## Verify it's real sync (not polling)

Open the same session in **two browser windows**. Start a run in one — the agent's
messages, tool calls, and your interceptions appear **live in both** with no reload.
Open DevTools → Network: you'll see Electric's long-lived `/v1/shape` stream and
discrete `POST /writes`, **never a polling loop**.

---

## Architecture

```
Browser (Vite + React + TanStack DB)
  │  reads  ── GET /sync/:collection ──►  Server (Fastify)  ──►  Electric  ──►  Postgres
  │  writes ── POST /writes (returns txid) ─────────────────────────────────────►
  │  auth   ── WorkOS AuthKit (bearer token; sub scopes every read/write)
  ▼
Agent daemon (PORTLESS, outbound only) ── appends events to ──►  Postgres
```

- **Event log is the truth.** One append-only `events` table; `messages`, tool
  calls, and session status are projections. Live streaming, multi-window viewing,
  interrupt-audit, and crash-only resume all fall out of it.
- **Electric is read-path only.** Writes go through the server's generic `/writes`
  endpoint, which captures `pg_current_xact_id()` *inside* the mutation transaction
  and returns it so the optimistic UI reconciles against the exact transaction.
- **Control-plane-via-data-plane.** Interrupt / approve / reject / override are
  rows that sync into the portless agent — no second channel, no websocket.
- **Single typed schema spine.** `packages/schema` (drizzle + drizzle-zod) emits
  the DDL, row types, payload validation, and the agent's tool schemas.

### Security model

- **WorkOS AuthKit** issues bearer tokens; the server verifies each against the
  WorkOS JWKS (`jose`). The JWT `sub` is the per-user identity.
- **Electric is public by default** — so the only way in is the server's proxy,
  which injects `where user_id = <sub>` (the client never authors a filter), adds
  `Vary: Authorization` so a cache can't leak rows across users, and gates
  events/controls on session ownership. Logout forces a reload to flush synced rows.

### Constraint compliance (PRD)

TypeScript end to end · Electric SQL + TanStack DB + Postgres · **no** Next.js ·
**no** websockets · **no** coding-agent SDK (the loop is built on the Vercel AI SDK) ·
`docker compose up` with only a `.env` · the **agent container exposes no ports**.

---

## Repository layout

```
packages/schema   drizzle tables + drizzle-zod + tool policy (single source of truth)
apps/server       Fastify: /writes (txid), Electric auth proxy, WorkOS verify, migrations
apps/agent        portless daemon: agent loop, tools, interception, crash-only resume
apps/web          Vite + React + TanStack DB: shell, live trace, interception console
```

## Development

```bash
pnpm install
pnpm -r typecheck            # strict TS across all packages
pnpm -r test                 # unit + integration (needs a local Postgres on :54321)
pnpm -r test:coverage        # enforced at 100% lines/functions/statements
pnpm --filter @steer/web e2e # Playwright two-window live-sync test (self-contained)
```

Integration tests run against a real Postgres (`docker compose up -d postgres`). The
two-window E2E drives two browser tabs through a shared store harness (no external
services), proving the live cross-window sync UX.

## Demo

A Loom walkthrough (architecture, data model, security model, and a live
interception) is linked here: **[Loom — TODO]**.
