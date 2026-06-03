---
description: The portless coding-agent daemon (`apps/agent`) — polls Postgres for sessions, runs the agent loop, executes tools under live operator interception, and streams validated events back to the synced event log.
icon: cpu
---

# Agent Daemon

## 1. Responsibilities

1. **Poll for work.** Select sessions whose `lastStatus` is `starting` (fresh task) or `running` (a run that crashed mid-flight) and dispatch them (`daemon.ts → pollAndRun`).
2. **Drive the agent loop.** For each step: read the synced event log, ask the model driver for the next step (`thinking` / `say` / `tool` / `complete`), and append exactly one terminal event per step (`loop.ts → runSession`).
3. **Execute tools** inside an ephemeral per-session temp workspace, refusing path traversal outside it (`tools/index.ts`).
4. **Live tool interception.** Gate side-effecting tools behind operator approval (U8), substitute/edit tools via override with an audit trail (U9), and cancel-and-substitute in-flight read-only tools (U10) (`intercept.ts → resolveTool`).
5. **Honor operator controls** — `interrupt` / `approve` / `reject` / `override` — as synced Postgres rows (control-plane-via-data-plane); no second channel, no websocket (`loop.ts`, `intercept.ts`, `store.ts`).
6. **Write the event log directly.** As a trusted server-side writer, append schema-validated events straight to Postgres and derive the completed-step cursor that makes crash-only resume possible (`store.ts`, `loop.ts → completedSteps`).
7. **Resolve the LLM and build context.** Pick the provider (OpenAI/Anthropic) from env and project the event log into model messages, rendering an override as the executed tool plus a system note (`model.ts`, `provider.ts`, `context.ts`).
8. **Not responsible for**: any network endpoint, HTTP, auth, or the Electric proxy and `/writes` API — those live in **`apps/server`** (the agent is portless and outbound-only). It does **not** define the DB schema, tool policy, or payload validators — those are owned by **`packages/schema`**. It does **not** render anything — that is **`apps/web`**.

## 2. Process Model & Lifecycle

**Startup sequence** (`src/index.ts`):
1. `createPool()` reads `DATABASE_URL` and throws if it is unset (`db.ts`).
2. `createDb(pool)` builds a Drizzle client over `{ sessions, events, controls }`.
3. Initialize an in-process `active: Set<string>` (double-run guard) and log `"[agent] daemon up (outbound only)"`.
4. Enter an unbounded loop: `await pollAndRun(db, active)`, then `setTimeout` 1500 ms. Any thrown error is caught and logged (`"[agent] poll error"`); the loop continues.

**Per-session dispatch** (`daemon.ts → pollAndRun`):
1. `select … where lastStatus in ('starting','running')`.
2. Skip any id already in `active`; otherwise add it.
3. `mkdtemp(os.tmpdir()/steer-<sessionId>-…)` for an isolated workspace.
4. `createModelDriver({ model, task })`, then `runSession(store, driver, id, { workspaceRoot, tools })` — fired as a detached async task.
5. On any throw → `store.setStatus(id, 'error')`; `finally` → `active.delete(id)`.

**Teardown sequence:**
1. None wired in source. `index.ts` runs an infinite loop with no `SIGTERM`/`SIGINT` handler; the process is stopped externally (container kill). `RunOptions.signal` / `resolveTool`'s `AbortController` plumbing exists to let a waiting gate exit cleanly, but `daemon.ts` passes **no** signal into `runSession`, so there is no graceful in-flight drain in production — only the per-step interrupt path halts a run cleanly.

**Recovery / crash behavior:** Crash-only resume. The agent keeps no private state — every run reads from and appends to the synced event log. On boot, sessions still in `running` are re-selected and resumed; `completedSteps(events)` recomputes the cursor by counting terminal events (`thinking`, `message`, `tool_result`, `tool_cancelled`, `tool_substituted`), so committed steps are not re-run. A session set to `error` falls out of the poll predicate and is not retried.

**Platform guards:** None. No OS-specific compile/runtime guards. Runs on `node:22-alpine` (Dockerfile); the `bash` tool spawns `sh -c`.

## 3. Directory Layout

```
apps/agent/
├── Dockerfile              # node:22-alpine; pnpm install --filter @steer/agent...; PORTLESS (no EXPOSE); CMD `pnpm serve`
├── package.json            # @steer/agent; deps: ai, @ai-sdk/{openai,anthropic}, drizzle-orm, pg, @steer/schema
├── tsconfig.json           # ESNext + Bundler resolution, extends root base, noEmit
├── vitest.config.ts        # fileParallelism:false; 100% line/fn/stmt coverage; excludes index/daemon/model/db
└── src/
    ├── index.ts            # entrypoint: build db, log banner, poll every 1500 ms (excluded from coverage)
    ├── daemon.ts           # pollAndRun: select startable sessions, mkdtemp workspace, spawn runSession (excluded)
    ├── loop.ts             # runSession + ModelDriver/ScriptedModel + completedSteps (crash-only cursor)
    ├── intercept.ts        # resolveTool: U8 approval gate / U9 override+audit / U10 cancel-and-substitute
    ├── context.ts          # buildContext: project event log → LLM messages (override → executed tool + system note)
    ├── model.ts            # createModelDriver: Vercel AI SDK generateText, provider-agnostic (external boundary, not unit-tested)
    ├── provider.ts         # resolveProvider / resolveModelId from env
    ├── store.ts            # createDbStore → AgentStore: append/list events, list/consume controls, setStatus
    ├── db.ts               # createPool / createDb (pg.Pool + drizzle) (excluded from coverage)
    ├── tools/
    │   ├── index.ts        # 7 tools (read_file,list_dir,grep,glob,web_fetch,write_file,bash) + safeJoin guard
    │   └── tools.test.ts   # tool unit tests incl. path-traversal refusal, bash exit marker
    ├── loop.test.ts        # ordered run, interrupt halt, crash resume, tool-error capture, write_file approval
    ├── intercept.test.ts   # U8 gate / U9 override / U10 live-cancel scenarios
    ├── context.test.ts     # context projection incl. substitution-as-executed
    └── provider.test.ts    # provider + model-id resolution
```

**Missing / notable absences:**
- No `tests/` directory — tests are colocated `*.test.ts`.
- No HTTP server, router, or port — portless by design (PRD constraint; the Dockerfile has no `EXPOSE`).
- No env-schema/validation module — env is read ad hoc (`DATABASE_URL` in `db.ts`; `LLM_*` in `provider.ts`/`model.ts`).
- No graceful-shutdown / signal handler and no cleanup of the per-session `mkdtemp` workspace (temp dirs accumulate until the container is recycled).

## 4. Data Flow

```
   apps/web (operator) ──POST /writes──► apps/server ──► Postgres: controls / sessions
                                                              │  ▲
                       (interrupt/approve/reject/override)    │  │ append events (direct, trusted writer)
                                                              ▼  │
  index.ts loop ──every 1500ms──► daemon.pollAndRun           │  │
        select sessions where lastStatus in (starting,running)│  │
                       │  mkdtemp workspace                    │  │
                       ▼                                       │  │
            loop.runSession(sessionId)  ◄──────── listEvents / listControls
        ┌──────────────────────────────────────────────────────────────┐
        │ per step:                                                      │
        │  1. listUnconsumedControls → interrupt? → append 'interrupted' │
        │  2. listEvents → cursor = completedSteps(events)               │
        │  3. driver.next(events,cursor) → thinking | say | tool | complete
        │  4. thinking→'thinking'  say→'message'  complete→status 'completed'
        │  5. tool → append 'tool_proposed' → intercept.resolveTool(...)  │
        └───────────────────────────────┬──────────────────────────────┘
                                        ▼
                       intercept.resolveTool (one tool step)
        side-effecting → U8 gate: poll controls, NO exec until a decision arrives
        read-only      → U10: run live under AbortController; a control aborts + discards partial output
        decision: approve → 'tool_result'   reject → 'tool_cancelled'
                  override(newTool) → 'tool_substituted'   override(newArgs) → 'tool_result'
                                        │
                store.appendEvent → INSERT events(seq = max+1) ─► Electric shape ─► apps/web UI (live)
```

**Model driver turn** (`model.ts`, production):
```
driver.next(events) → buildContext(task, events)
                    → generateText(provider model, system prompt, toolSet, maxSteps:1)
                    → toolCalls[0] ? {t:'tool', …}
                                   : text≠lastMessage ? {t:'say', text} : {t:'complete'}
```

## 5. Surface Area Catalog

### Commands / API Surface

The agent exposes **no** network/RPC surface (portless). Its contract is (a) the exported module API and (b) the event/control vocabulary it reads and writes through Postgres.

**Exported module API**

| Name | Purpose | Input | Output |
|------|---------|-------|--------|
| `pollAndRun(db, active)` | Select startable sessions and dispatch runs | `Db`, `Set<string>` | `void` (spawns detached runs) |
| `runSession(store, driver, id, opts)` | Run a session to completion / interrupt | store, driver, id, `{ workspaceRoot, tools, signal?, pollMs? }` | `void`; appends events, sets status |
| `resolveTool(store, id, step, deps)` | Resolve one tool step with interception | store, id, `ToolStep`, `{ tools, workspaceRoot, pollMs, signal? }` | `'resolved' \| 'interrupted'` |
| `completedSteps(events)` | Crash-only resume cursor | `StoredEvent[]` | `number` (count of terminal events) |
| `buildContext(task, events)` | Project event log → LLM messages | `string\|null`, events | `ContextMessage[]` |
| `createModelDriver({ model, task })` | Provider-agnostic LLM driver | `{ model, task }` | `ModelDriver` |
| `resolveProvider(env)` / `resolveModelId(provider, tier, env)` | Env → provider / concrete model id | env object | `Provider` / model-id string |
| `createDbStore(db)` | Event-log store façade | `Db` | `AgentStore` |
| `tools` | Tool registry | — | `Record<string, ToolFn>` (7 entries) |

**Event types written** (`store.appendEvent`, payloads validated by `parseEventPayload`): `thinking`, `message`, `tool_proposed`, `tool_result`, `tool_cancelled`, `tool_substituted`, `interrupted`. Terminal (counted by `completedSteps`): all except `tool_proposed` and `interrupted`.

**Control types consumed** (`listUnconsumedControls` → `consumeControl`): `interrupt`, `approve`, `reject`, `override`. **Session statuses set**: `running`, `completed`, `interrupted`, `error` (reads `starting` / `running`).

**Tool registry** (`tools/index.ts`; kind from `classifyTool` in `@steer/schema`)

| Tool | Kind | Input | Output |
|------|------|-------|--------|
| `read_file` | read-only | `{ path }` | file contents |
| `list_dir` | read-only | `{ path }` | entry names (`/` suffix on dirs), sorted |
| `grep` | read-only | `{ pattern, path }` | `relpath:line:text` matches (or `— no matches`) |
| `glob` | read-only | `{ pattern }` | matching relative paths (or `— no files`) |
| `web_fetch` | read-only | `{ url }` | response text, truncated to 4000 chars |
| `write_file` | side-effecting | `{ path, content }` | `Wrote <path> · N lines` (only after approval/override) |
| `bash` | side-effecting | `{ command }` | combined stdout+stderr (+ `[exit N]` on non-zero); gated |

**Removed / non-existent commands:** None. There are no HTTP routes by design; unknown tool names resolve to an `error: unknown tool <name>` result string and (via `classifyTool`) default to the gated side-effecting class.

### Configuration / Environment Variables

| Variable | Default | Purpose | Consumer |
|----------|---------|---------|----------|
| `DATABASE_URL` | none — `createPool` throws if unset | Postgres connection string | `db.ts` (and the `dev` npm script injects a `localhost:54321` default) |
| `LLM_PROVIDER` | auto-detect | Force `openai` or `anthropic` | `provider.ts → resolveProvider` |
| `OPENAI_API_KEY` | none | OpenAI auth; presence selects OpenAI when no explicit provider | `@ai-sdk/openai` (`model.ts`), `resolveProvider` |
| `ANTHROPIC_API_KEY` | none | Anthropic auth; final fallback provider | `@ai-sdk/anthropic` (`model.ts`), `resolveProvider` |
| `OPENAI_MODEL` | `OPENAI_MODELS[tier]` ?? `gpt-4o-mini` | Override the resolved OpenAI model | `provider.ts → resolveModelId` |
| `ANTHROPIC_MODEL` | `ANTHROPIC_MODELS[tier]` ?? `claude-3-5-sonnet-latest` | Override the resolved Anthropic model | `provider.ts → resolveModelId` |

Provider order: explicit `LLM_PROVIDER` wins → else `OPENAI_API_KEY` → else `ANTHROPIC_API_KEY` → else `anthropic`. Tier→model maps: `sonnet/opus/haiku` → `gpt-4o/gpt-4o/gpt-4o-mini` (OpenAI) or `claude-3-5-sonnet-latest/claude-3-opus-latest/claude-3-5-haiku-latest` (Anthropic).

### Bundled Resources / Assets

None. Nothing is packaged with the binary. The only runtime artifact is an ephemeral per-session workspace created by `mkdtemp(os.tmpdir()/steer-<sessionId>-…)`; it is created on dispatch and never explicitly removed.

## 6. Security & Failure Boundaries

- **Input validation:** Tool arguments are validated by `validateToolArgs` (Zod, `@steer/schema`) before execution; every appended event payload is validated by `parseEventPayload`. `safeJoin(root, path)` resolves and rejects any path escaping the workspace (`..` or absolute) for `read_file` / `list_dir` / `grep` / `glob` / `write_file`. **Caveats:** `web_fetch` fetches an arbitrary URL with no allow-list, and `bash` runs an arbitrary `sh -c` command — both are contained only by the temp-workspace `cwd`, not sandboxed. `bash` and `write_file` are side-effecting, so they cannot run without an operator `approve`/`override`; `web_fetch` is read-only and runs live (cancellable).
- **Auth / session gating:** None inside the agent. It is a trusted server-side writer with direct DB access and processes only rows that were already written through the authenticated `apps/server` write path; there is no per-user check here. Operator gating is enforced via control rows — a side-effecting tool holds at the U8 gate indefinitely until a decision control for its `toolCallId` arrives.
- **Resource caps:** `generateText` runs with `maxSteps: 1` (one tool call per turn); `web_fetch` truncates output to 4000 chars; control poll interval defaults to 200 ms (`pollMs`), daemon poll to 1500 ms. There is **no** max-iteration ceiling on the run loop, **no** per-tool timeout, and **no** workspace size/memory cap.
- **Dependency-down behavior:** Missing `DATABASE_URL` → throws at startup. Postgres errors during polling are caught in the `index.ts` loop, logged, and retried on the next tick. A session run that throws → status `error`. An unknown tool returns an `error: unknown tool …` string (no throw); a tool that throws is captured as `error: <message>` in the result.
- **Self-healing / retry logic:** The poll loop retries every 1500 ms after any error (no backoff). Crash-only resume re-runs `running` sessions from the log on boot. A session set to `error` is **not** re-polled (it leaves the `starting`/`running` predicate), so a repeatedly-failing session stops rather than looping forever.

## 7. Related & Links Out

- [Architecture overview](../overview.md)
- [Server (writes, Electric proxy, auth)](./server.md) — the authenticated write path the agent's rows flow through, and the read proxy that streams its events to the UI
- [Schema (tables, tool policy, payload validation)](./schema.md) — `@steer/schema`, source of `classifyTool`, `validateToolArgs`, `parseEventPayload`, and the table definitions
- [Web (interception console / live trace)](./web.md) — the operator UI that issues the controls this daemon consumes
