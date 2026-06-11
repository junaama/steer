# PRD Requirements → Test Traceability

Every requirement from the take-home PRD mapped to the test(s) that exercise it.
Behavioral tests assert against real Postgres reads or rendered DOM — never
inferred outputs. Run everything with `pnpm -r test` (integration tests need a
local Postgres on `:54321`; the two-window E2E is `pnpm --filter @steer/web e2e`).

## System components

| PRD | Requirement | Test(s) |
|---|---|---|
| 1a | Server provides an API for user interaction | `apps/server/src/prd-session-lifecycle.test.ts`, `apps/server/src/server.test.ts` |
| 1b | Server provides sync-driven functionality (txid + Electric proxy) | `prd-session-lifecycle.test.ts` ("returns the in-transaction txid"), `server.test.ts` (proxy) |
| 2a | Postgres persistence | `prd-session-lifecycle.test.ts` (every assertion reads the row back), `messages.test.ts` |
| 2b | Electric SQL sync engine (server proxies to it) | `server.test.ts` (`/sync/:collection` shape proxy), `prd-compliance.test.ts` (C6 deps) |
| 3a | Agent runs anywhere, connects out only (no inbound) | `prd-compliance.test.ts` (portless agent, agent env has DATABASE_URL/SERVER_URL), `apps/agent/src/workspace.test.ts` (daemon root + session workdir resolution), `apps/web/src/components/NewSessionModal.test.tsx` (client default workdir) |
| 3b | Agent loop (inference calls, state) | `apps/agent/src/loop.test.ts`, `apps/agent/src/model` driver via `context.test.ts` |
| 3c | Starting the agent is a CLI command | `prd-compliance.test.ts` (3c: `serve` script + `steer` bin + `./steer`) |
| 3d | Receives sessions from the server via Electric sync | `apps/agent/src/intake.test.ts` |
| 3e | Runs sessions, emits events (tool calls, thinking, messages) | `loop.test.ts` (ordered `thinking/message/tool_*` events), `intercept.test.ts` |

## User interface

| PRD | Requirement | Test(s) |
|---|---|---|
| 4a | Reactive UI talks to the server API for session creation | `apps/web/src/components/Sidebar.test.tsx`, `prd-session-lifecycle.test.ts` (create) |
| 4b | ALL collections synced via Electric + TanStack DB | `apps/web/src/data/decode.test.ts` (wire decode), `server.test.ts` (sessions/events/controls proxy) |
| 4c | Running sessions stream to the client live | `apps/web/e2e/two-window.spec.ts` (live cross-window sync) |
| 4d-i | Login & logout | `prd-session-lifecycle.test.ts` (signup→token→/auth/me), `apps/server/src/auth-routes.test.ts`, `auth-session.test.ts` |
| 4d-ii | View & navigate a list of own sessions | `prd-session-lifecycle.test.ts` (sync scoped to user), `Sidebar.test.tsx` |
| 4d-iii | Create & delete sessions | `prd-session-lifecycle.test.ts` (create / delete + cascade), `Sidebar.test.tsx` (new/delete) |
| 4d-iv | Interrupt & continue sessions | `prd-session-lifecycle.test.ts` (interrupt control + continue), `loop.test.ts` (interrupt halts) |
| 4d-v | Update (rename) & delete sessions | `Sidebar.test.tsx` (inline rename), `prd-session-lifecycle.test.ts` (update), `write-client.test.ts` |
| — | Follow-up turns / multi-turn (`steer … --session`) | `apps/server/src/messages.test.ts`, `apps/agent/src/context.test.ts` (user_message → user turn), `apps/cli/src/commands.test.ts` (resolveSession / run --session) |
| Performance | React UI performance for long running traces | `apps/web/src/components/SessionDetail.test.tsx` (`resolveTraceRows` windows long transcripts), `apps/web/src/components/SessionDetail.tsx` (`@tanstack/react-virtual`) |

## Constraints

| PRD | Constraint | Test(s) |
|---|---|---|
| C1 | Entirely TypeScript, strict | `prd-compliance.test.ts` (C1), `prd-build.test.ts` (whole-repo typecheck) |
| C2 | Auth & authorization boundary | `prd-session-lifecycle.test.ts` (401 anon, 403 cross-user, server-injected user_id), `cors.test.ts`, `auth.test.ts`, `prd-loop-gates.test.ts` (base Electric is not directly published) |
| C3 | No coding-agent SDK; LLM/agent SDKs OK | `prd-compliance.test.ts` (C3: forbidden absent, `ai` present) |
| C4 | No Next.js | `prd-compliance.test.ts` (C4) |
| C5 | Includes a docker-compose config | `prd-compliance.test.ts` (C5/C10) |
| C6 | Sync uses Electric SQL + TanStack DB + Postgres | `prd-compliance.test.ts` (C6) |
| C7 | No websockets (or non-Postgres DBs) | `prd-compliance.test.ts` (C7: deps + source scan) |
| C8 | LLM key via `.env`, documented | `prd-compliance.test.ts` (C8, checked from compose + README without opening env files) |
| C10 | Compose has server+UI, db, Electric, agent containers | `prd-compliance.test.ts` (C5/C10) |
| C11 | Server+UI publish ports; agent container opens none | `prd-compliance.test.ts` (C11 + source-level portless), `prd-loop-gates.test.ts` (default ports remain remappable when host ports are occupied) |
| C12 | `docker compose up` builds with only a `.env`; project builds | `prd-compliance.test.ts` (migrate one-shot), `prd-loop-gates.test.ts` (base Electric internal), `prd-build.test.ts` |
| Gate | `prd-compile` deterministic Stop hook | `prd-loop-gates.test.ts` (root `verify`, `.claude/settings.json` Stop hook), `scripts/verify.mjs` |

## Deliverables

| PRD | Deliverable | Test(s) |
|---|---|---|
| D1 | README with reviewer run instructions | `prd-compliance.test.ts` (D1) |
| D2 | README links a web-viewable demo | `prd-compliance.test.ts` (D2: `docs/demo/steer-demo.webm` link + file existence) |
| D3 | AI coding-agent config dir included | `prd-compliance.test.ts` (D3: `CLAUDE.md`) |

## Notes

- **D2** is supplied by the checked-in WebM linked from the README. The PRD
  example named Loom; the supplied artifact is a browser-viewable repo-local
  recording so reviewers can inspect the flow without an external account.
- **Full `docker compose up` boot** is validated structurally by parsing
  `docker compose config` (no daemon needed). On 2026-06-07 the stack also
  booted end-to-end with the same services on remapped host ports because local
  `:8080` was occupied: server `/health` returned 200 and the web root returned
  200.
- `pnpm verify` is the deterministic local Stop-hook gate. It intentionally
  excludes live DB, LLM, and deploy oracles; run those on demand.
- The integration suites reset package-local throwaway databases by default
  (`steer_server_test`, `steer_agent_test`). Set `TEST_DATABASE_URL` only when
  you intentionally want to use a different disposable database.
