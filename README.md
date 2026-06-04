# Steer

A sync-based headless coding agent with a reactive web UI, and the ability to steer it live. Watch the agent work in real time, and reach into a running tool call to swap, edit, or approve it: cancel a wasteful `grep` mid-flight and substitute a `read`, or gate a `write_file` behind approval — without restarting the run or re-planning.

Built on Postgres as the single source of truth, with the UI and agent as pure projections of synced state through Electric SQL + TanStack DB.

---

## Quick start

Prerequisites: Docker and an OpenAI or Anthropic API key (for the agent). Auth is self-hosted.

```bash
git clone <this-repo> steer && cd steer
cp .env.example .env        # fill in one LLM key: ANTHROPIC_API_KEY or OPENAI_API_KEY
docker compose up --build   # builds + starts the whole stack
```

Then open http://localhost:5173, sign up with any email + password (min 8 chars), and create a session.

No extra build steps. `docker compose up` brings up Postgres, Electric, the server/UI, and the (portless) agent. The first boot builds images and runs DB migrations automatically.

Optional — seed a demo account + sessions: `docker compose exec server pnpm seed` seeds a login-able account (`demo@steer.dev` / `steerdemo123`) with example sessions. Override with `SEED_USER_EMAIL` / `SEED_USER_PASSWORD`.

### Configuration (`.env`)

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` *or* `ANTHROPIC_API_KEY` | the coding agent's model. Provider is auto-detected (OpenAI preferred when both set) or pinned with `LLM_PROVIDER=openai\|anthropic`; override the model with `OPENAI_MODEL` / `ANTHROPIC_MODEL` |
| `DATABASE_URL` | defaults to the local Postgres container; point it at a [Neon](https://neon.tech) connection string for a hosted database |

Auth requires no configuration. Session tokens are self-issued and verified against Postgres. The only key required is an LLM provider key for the agent.

---

## Start sessions from the CLI

The daemon picks up any session in `starting` status. The `steer` CLI is the no-UI way to create one — log in once, then start a session from a prompt:

```bash
./steer login                 # prompts for email + password (new account: ./steer signup)
./steer "fix the flaky checkout test"          # creates a session; the daemon runs it within ~1.5s
./steer "summarize the repo" --watch           # …and stream thinking/tool calls/messages in your terminal
./steer "now add tests" --session <id|name>    # follow-up turn to an existing session (resumes it)
./steer ls                    # list your sessions (id, status, title)
./steer watch <session-id>    # tail an existing run
```

`./steer` (from the repo root) needs no build; `pnpm steer …` works too. Token is stored in `~/.steer/credentials.json` (0600). Point at another server with `--server <url>` or `$STEER_SERVER_URL`; pick a model tier with `--model sonnet|opus|haiku`. For a bare `steer` on your PATH: `pnpm --filter @steer/cli build && pnpm --filter @steer/cli link --global`.

### `steer` runs where you run it

`./steer "…"` binds the session to the **directory you ran it from** — the CLI sends its cwd, and the daemon runs the agent there. Run it in `~/dev/my-app` and `read_file`/`list_dir`/`grep`/`write_file`/`bash` all act on that project's files. (`--workdir <dir>` overrides it.)

For that to work from the default `docker compose up` container, the stack mounts the **host filesystem** at `/host` and roots the daemon there (`WORKSPACE_DIR` defaults to `/`), so wherever the stack is pulled down it can reach any directory you `cd` into. A session bound to `/Users/you/app` is mapped to `/host/Users/you/app` inside the container; a task can reach anywhere under the root ("request broader scope"), so the agent's reach is the whole machine **by design** — and `bash` is an uncontained real shell.

```bash
docker compose --env-file .env.local up         # default: host fs mounted, cwd-routing works
WORKSPACE_DIR=~/dev/my-app docker compose up     # narrow it for a sandboxed deploy
```

> Whole-machine reach is the intended default for a tool you run on your own machine. To sandbox it, set `WORKSPACE_DIR` to a single project (cwd-routing then only resolves paths under that dir). On macOS/Windows, Docker Desktop must be allowed to share the mounted path (Settings → Resources → File sharing) — or run a **local daemon** (see "Run it anywhere") which works on your real paths with no mount.

The web UI at **http://localhost:5173** is your remote control: watch every session live, and **approve / swap / reject** side-effecting tools (`write_file`, `bash`) — those pause for approval, so an autonomous CLI run uses read-only tools until you steer it from the UI. A run stops as soon as a model repeats a tool call with no new result (a stuck loop), and is hard-capped at `STEER_MAX_STEPS` (default 80) as a backstop — so a stuck model can't loop forever.

> The agent needs an LLM key **in its container** to actually run a session. `docker compose up` reads `.env` only — if your key lives in `.env.local`, start the stack with `docker compose --env-file .env.local up` (otherwise sessions get picked up but immediately go to `error`).

### Run it anywhere — a local agent on your own machine

The container agent above is the **default daemon**: it runs sessions created without an environment. To run the agent **on your own machine against your own files** (the PRD's "run anywhere — workstation, sandbox, container"), start a *local* daemon bound to an environment and route sessions to it.

A session carries an `environment`, and exactly one daemon **claims** it (single-owner). So the same session — viewed in the web UI, continued with a follow-up — always targets that environment's filesystem; it can never run on the wrong machine. A session whose environment has no daemon connected simply **queues** until you start one there.

```bash
# 1. Expose the data plane to your host (the dev override publishes Electric to 127.0.0.1:3000):
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres electric migrate server

# 2. Run a daemon on your machine, pointed at the project it should work on:
STEER_WORKSPACE_ROOT=~/dev/my-app pnpm --filter @steer/agent agent --env laptop
#    (the `agent` script defaults DATABASE_URL→:54321 and ELECTRIC_URL→:3000 — the
#     endpoints the dev override exposes. This is the `steer-agent` daemon bin.)

# 3. Route a session to that environment — it runs against ~/dev/my-app's files:
./steer "list the files in this project" --env laptop   # --env is sticky after first use
```

The web UI now shows the session with an `env: laptop` badge, and any follow-up (`./steer "…" --session <id>`) resumes on the **same** machine. Sessions started without `--env` (or from the web "New session") stay unrouted and run on the container's `/workspace`, exactly as before — so `docker compose up` is unchanged.

---

## Verify it's real sync

Open the same session in two browser windows. Start a run in one — the agent's messages, tool calls, and your interceptions appear live in both with no reload. Open DevTools → Network to see Electric's long-lived `/v1/shape` stream and discrete `POST /writes`.

---

## Architecture

```
Browser (Vite + React + TanStack DB)
  │  reads  ── GET /sync/:collection ──►  Server (Fastify)  ──►  Electric  ──►  Postgres
  │  writes ── POST /writes (returns txid) ─────────────────────────────────────►
  │  auth   ── self-hosted session token (bearer; sub scopes every read/write)
  ▼
Agent daemon (portless, outbound only) ── appends events to ──►  Postgres
```

- Event log is source of truth. One append-only `events` table; messages, tool calls, and session status are projections. Live streaming, multi-window viewing, interrupt-audit, and crash-only resume all fall out of it.
- Electric is read-path only. Writes go through the server's generic `/writes` endpoint, which captures `pg_current_xact_id()` inside the mutation transaction and returns it so the optimistic UI reconciles against the exact transaction.
- Control-plane-via-data-plane. Interrupt / approve / reject / override are rows that sync into the portless agent.
- Single typed schema spine. `packages/schema` (drizzle + drizzle-zod) emits the DDL, row types, payload validation, and the agent's tool schemas.

### Security model

- Self-hosted session auth. Email + password (scrypt-hashed via `node:crypto`); on login the server mints a high-entropy opaque token and stores only its SHA-256 hash as the session id. The SPA sends the token as a bearer; the server resolves it to a `users.id` on every request. No external IdP, no auth keys to configure.
- Electric is public by default — access is through the server's proxy, which injects `where user_id = <sub>`, adds `Vary: Authorization`, and gates events/controls on session ownership. Logout invalidates the server session and forces a reload.

### Constraint compliance (PRD)

TypeScript end to end · Electric SQL + TanStack DB + Postgres · no Next.js · no websockets · no coding-agent SDK (the loop is built on the Vercel AI SDK) · `docker compose up` with only a `.env` · the agent container exposes no ports.

---

## Repository layout

```
packages/schema   drizzle tables + drizzle-zod + tool policy (single source of truth)
apps/server       Fastify: /writes (txid), Electric auth proxy, session auth, migrations
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

Integration tests run against a real Postgres (`docker compose up -d postgres`). The two-window E2E drives two browser tabs through a shared store harness, proving the live cross-window sync UX.

### Run locally (hot reload)

`docker compose up` is the one-shot deliverable, but rebuilds an image on every change. For a tight edit-loop, run the app you're working on on the host (Vite HMR / `tsx watch`) against containerized infrastructure. The host dev scripts read the repo-root `.env` and `.env.local`: they inject the localhost `DATABASE_URL` / `ELECTRIC_URL` (the file's values use Docker hostnames the host can't resolve) and pull the model key from the file.

> `docker compose` auto-reads `.env` only. If your LLM key lives in `.env.local`, add `--env-file .env.local` to the `docker compose` commands below.

Tier 1 — hot-reload the UI (most common). Backend in Docker, web on the host:

```bash
docker compose up server agent                 # starts postgres, electric, migrate, server, agent
PORT=5180 pnpm --filter @steer/web dev         # Vite + HMR (any free port; omit PORT for 5173)
```

Open http://localhost:5180. The browser hits the Dockerized server on `:8080` (CORS-enabled), which proxies to Electric internally. Edit `apps/web` and the UI hot-reloads.

Tier 2 — hot-reload server / agent too. Only the data plane runs in Docker; the override publishes Electric to `127.0.0.1:3000`. Run each in its own terminal:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up postgres electric
pnpm --filter @steer/server migrate:local   # apply migrations to the host-reachable Postgres
pnpm --filter @steer/server dev             # tsx watch  → :8080
pnpm --filter @steer/agent  dev             # tsx watch, portless
PORT=5180 pnpm --filter @steer/web dev      # tsx/Vite HMR → :5180
```

When the UI runs on a non-default port, point it at the server with `VITE_SERVER_URL=http://localhost:8080` (the default). Self-hosted auth has no redirect URI to register, so a non-default UI port needs no extra auth config.
