---
status: active
type: feat
created: 2026-06-03
title: "feat: bring Steer's agent up to coding-agent parity (surgical edits, self-verify loop, todo, subagents, LSP, MCP)"
origin: /tmp/steer-prd/PRD.md (the take-home PRD — Headless Coding Agent / Daemon)
depth: deep
---

# feat: Coding-agent parity for the Steer daemon

## Summary

The PRD calls for a real "headless coding agent" with an "agent loop including
inference API calls, state, etc." Today Steer's agent has **7 tools**
(`read_file`, `list_dir`, `grep`, `glob`, `web_fetch`, `write_file`, `bash`),
edits files by **full rewrite only**, and effectively does *one tool then a
message*. That does not reflect what a coding agent is in 2026.

This plan brings the agent up to parity with the modern coding-agent tool
surface and agent-loop behaviors, in scope-confirmed **Max** breadth:

1. **Surgical editing** — `edit_file` (exact-string replace) and `multi_edit`
   replacing full-file rewrite as the primary edit path, with the existing
   diff + approval-gate UX.
2. **Self-verifying loop** — a `run_command` test/build tool plus the loop and
   prompt changes so the model chains edit → run tests → read failures → edit →
   re-run until green, instead of stopping after one tool.
3. **Planning surface** — a `todo_write` tool + a `plan` projection rendered as
   a live checklist.
4. **Subagents** — a `task` tool that runs a bounded child loop with a scoped
   toolset and isolated context, summarizing back to the parent.
5. **LSP/diagnostics** — read-only `diagnostics` / `definition` / `references`
   tools backed by a language server child process.
6. **MCP client** — connect to configured MCP servers and surface their tools
   (gated as side-effecting) into the same interception model.

Every PRD hard constraint stays intact: TypeScript end-to-end; sync via Electric
SQL + TanStack DB + Postgres; the agent container stays **portless**; no Next.js,
no websockets, **no coding-agent SDK** (an MCP client and a language server are
infrastructure, not a pre-built agent); `docker compose up` still builds and
runs; the auth boundary and interrupt/continue are untouched. The existing
event-log-as-truth + interception model (`tool_proposed` → approval gate → diff,
read-only vs side-effecting policy in `packages/schema/src/tools.ts`) is the
spine every new capability flows through.

---

## Problem frame & current state

**The tool seam is already clean.** A tool is one entry in
`packages/schema/src/tools.ts` (`toolArgSchemas` + `TOOL_POLICY`) plus one impl
in `apps/agent/src/tools/index.ts` registered in the `tools` map. The model's
`toolSet` in `apps/agent/src/model.ts` is derived from `toolArgSchemas`
automatically; server `/writes` validation and the UI swap-picker
(`READ_ONLY_TOOLS`) consume the same source. So adding tools is mostly additive.

**The loop already chains tools.** `apps/agent/src/loop.ts` runs one
`driver.next()` per iteration; a tool step appends `tool_proposed`, runs
`resolveTool` (U8 gate / U9 override / U10 cancel), then loops. `decideStep`
(`apps/agent/src/decide.ts`) returns `tool` when the model calls a tool and
`complete` only when the model emits text with no tool after having already
spoken. Multi-step chaining therefore already works — the real blockers are
**(a)** the absence of surgical-edit and test-runner tools, **(b)** a system
prompt that does not instruct a verify-after-edit loop, and **(c)** the gate
cadence (every side-effecting call gates, which would stall a verify loop).

**What's missing vs. a 2026 coding agent** (grounded in current tool docs for
Claude Code, OpenCode, Codex CLI, Aider, and the VS Code agent harness):
surgical `Edit`/`MultiEdit`, a run-tests/build self-verify loop, a todo/plan
surface, subagents with scoped context, LSP/diagnostics, and MCP tool use.

---

## Requirements traceability (origin: /tmp/steer-prd/PRD.md)

| PRD element | This plan |
|---|---|
| §3b "agent loop including inference API calls, state" | U6 self-verify loop; U7 plan/todo state |
| §3e "runs sessions … sends events (tool calls, thinking, messages)" | all new tools emit `tool_proposed`/`tool_result`; U7/U8 add `plan`/subagent events |
| "real coding agent" (not a thin wrapper) | U1–U2 surgical edits, U5 run_command, U9 LSP, U10 MCP |
| Constraint: entirely TypeScript | all new code is TS; LSP/MCP servers are external processes, not source deps of the agent loop |
| Constraint: NOT a coding-agent SDK | MCP **client** + a language server are infrastructure; the loop is still hand-rolled on the Vercel AI SDK |
| Constraint: portless agent container | LSP runs over stdio child process; MCP over stdio/SSE outbound — no inbound ports |
| Constraint: `docker compose up` builds | U11 updates the agent Dockerfile for new runtime deps (LSP/MCP) with a verification that the image still builds |
| Constraint: Electric+TanStack+Postgres sync | new event types added to `packages/schema/src/schema.ts` flow through the existing proxy + decode untouched |
| Constraint: interrupt/continue, auth | unchanged — the loop's interrupt path and the server auth boundary are not modified |

---

## Key technical decisions

1. **`edit_file` = exact-string replace, not unified-diff patch.** `old_string`
   must match exactly once in the file (else error); replaced by `new_string`.
   This mirrors Claude Code's `Edit`, is robust to model formatting, and reuses
   the existing `computeDiff(before, after)` renderer. `multi_edit` applies an
   ordered array of such edits to a single file in one transaction.
2. **Surgical edits keep the write_file approval-gate + diff UX.** Generalize
   the before/after capture in `loop.ts` (today hard-coded to `write_file`) to
   all file-mutating tools: read the current file as `before`, compute `after`
   in memory, emit both on `tool_proposed`. No web changes needed — `ToolCard`
   already renders a diff whenever `after` is present.
3. **`run_command` is side-effecting, but the loop supports a per-session
   auto-approve allowlist.** The first `run_command` gates (operator sees it);
   the approval control may carry `alwaysAllow: true`, recorded as a session
   policy so subsequent identical-tool calls auto-run. This preserves the
   interception model as the default while letting a verify loop iterate without
   a gate every cycle. (The allowlist is the U6 mechanism, not a new tool kind.)
4. **Planning is an event projection, not a side table.** A `plan` event
   (`{ items: [{ text, status }] }`) is appended by `todo_write` and projected by
   `buildTrace` into a live checklist — consistent with event-log-as-truth.
5. **Subagents run an inner bounded loop in-process, summarized into the parent
   log.** The `task` tool spawns `runSession`-style iteration with a restricted
   toolset and its own context window seeded by a sub-prompt; the child's steps
   are recorded as events tagged with a `parentToolCallId` so the UI can nest
   them, and a final summary returns as the parent's `tool_result`. No new
   container, no ports — it is the same daemon process.
6. **LSP and MCP are read-path/outbound infrastructure.** A language server
   (e.g. `typescript-language-server`) runs as a stdio child of the agent;
   diagnostics/definition/references are read-only tools. MCP servers are reached
   over stdio/SSE outbound via `@modelcontextprotocol/sdk`; their tools register
   dynamically and default to side-effecting (gated). Neither opens an inbound
   port, so the portless constraint holds.
7. **`classifyTool` already fails safe.** Unknown/dynamically-registered tools
   (e.g. MCP) default to `side-effecting`, so they are gated by default — the
   trust posture is correct without extra work.

---

## High-level design

```
                         apps/agent/src/loop.ts  (runSession — unchanged scaffolding)
                                   │  driver.next()
                                   ▼
   model.ts ── toolSet (derived from toolArgSchemas + dynamic MCP tools) + system prompt(verify)
                                   │  tool step
                                   ▼
   loop.ts: append tool_proposed (before/after for ANY file-mutating tool)
                                   │
                                   ▼
   intercept.ts: U8 gate (side-effecting) / U9 override / U10 cancel
                 + per-session auto-approve allowlist (run_command)
                                   │  tool_result / tool_substituted / tool_cancelled
                                   ▼
   tools/index.ts: read_file … bash  +  edit_file, multi_edit, run_command,
                   todo_write, task(subagent), diagnostics/definition/references (LSP),
                   <mcp:server/tool> (dynamic)
                                   │  events
                                   ▼
   Postgres → Electric → apps/web (ToolCard diff/result + todo panel + nested subagent)
```
*Directional guidance for review, not implementation specification.*

---

## Output structure (new/changed files)

```
packages/schema/src/
  tools.ts                  # + edit_file, multi_edit, run_command, todo_write, task arg schemas + policy
  schema.ts                 # + 'plan', 'subagent_started', 'subagent_result' EVENT_TYPES
  zod.ts                    # + payloads for the new event types
apps/agent/src/
  tools/
    edit.ts                 # edit_file + multi_edit (new)
    run.ts                  # run_command (new)
    lsp.ts                  # diagnostics/definition/references via a language-server client (new)
    index.ts                # register new tools
  mcp.ts                    # MCP client: connect configured servers, register their tools (new)
  subagent.ts               # task tool: bounded inner loop with scoped toolset (new)
  loop.ts                   # generalize before/after; thread plan/subagent events; auto-approve allowlist
  model.ts                  # verify-loop system prompt; merge dynamic MCP tools into toolSet
  intercept.ts              # honor the auto-approve allowlist on the gate
  Dockerfile                # install language server + any MCP runtime deps
apps/web/src/
  lib/trace.ts              # project 'plan' → todo item; nest subagent events under their tool card
  components/
    TodoPanel.tsx           # live checklist (new)
    ToolCard.tsx            # run_command output; nested-subagent affordance
  lib/design.ts             # toolIcon entries for the new tools
docs/changelog/             # user-visible behavior note
```

---

## Implementation units

Phased; dependency-ordered. Each feature-bearing unit lists its test file and
must hold the repo bar: **100% lines/functions/statements, branches ≥90**, and
a real-run verification against the dockerized stack where noted. `apps/agent`
and `apps/server` DB-backed tests must run against a **throwaway Postgres**
(e.g. `:54322`), never the live `:54321` stack.

### Phase A — Surgical editing

### U1. `edit_file` tool (exact-string replace)

**Goal:** Add a surgical single-edit tool so the agent stops rewriting whole files.
**Requirements:** PRD §3b/§3e; "real coding agent."
**Dependencies:** none.
**Files:** `packages/schema/src/tools.ts`, `apps/agent/src/tools/edit.ts` (new),
`apps/agent/src/tools/index.ts`, `apps/agent/src/tools/tools.test.ts`,
`packages/schema/src/tools.test.ts`.
**Approach:** Schema `edit_file: { path, old_string, new_string }`, policy
`side-effecting`. Impl reads the file, requires `old_string` to occur exactly
once (error with a clear message on 0 or >1 matches), writes the replaced
content via `safeJoin`. Returns a confirmation (`Edited <path> · ±N lines`).
**Patterns to follow:** existing `write_file` in `tools/index.ts`; `safeJoin`
guard; `validateToolArgs`.
**Test scenarios:**
- Happy: unique `old_string` is replaced; file content on disk reflects it.
- Error: `old_string` absent → `error: …` result (no write); `old_string`
  matches 2+ times → `error: …` (ambiguous, no write).
- Edge: path traversal outside workspace is refused.
- Policy: `classifyTool('edit_file') === 'side-effecting'`; arg schema rejects
  missing fields.
**Verification:** tool unit tests green; `edit_file` appears in the model
toolSet (derived automatically) and in `validateToolArgs`.

### U2. `multi_edit` tool (ordered edits to one file)

**Goal:** Apply several edits to one file atomically.
**Dependencies:** U1.
**Files:** `packages/schema/src/tools.ts`, `apps/agent/src/tools/edit.ts`,
`apps/agent/src/tools/index.ts`, the two test files above.
**Approach:** Schema `multi_edit: { path, edits: [{ old_string, new_string }] }`,
`side-effecting`. Apply edits in order against an in-memory buffer; if any edit
fails to match uniquely, abort the whole operation (no partial write) and return
the failing edit's error. Write once at the end.
**Test scenarios:**
- Happy: three sequential edits all apply; final file correct.
- Error: the 2nd edit doesn't match → nothing written, error names the failed edit.
- Edge: an edit whose `old_string` was created by a prior edit in the same call
  applies correctly (ordered semantics).
**Verification:** unit tests green; partial-failure leaves the file untouched.

### U3. Generalize before/after diff to all file-mutating tools

**Goal:** `edit_file`/`multi_edit` get the same proposed-diff + approval UX as
`write_file`.
**Requirements:** preserve the interception/diff model.
**Dependencies:** U1, U2.
**Files:** `apps/agent/src/loop.ts`, `apps/agent/src/loop.test.ts`.
**Approach:** Replace the `step.name === 'write_file'` special-case in
`runSession` with a check against a set of file-mutating tools. For each, read
the current file (`before`), compute `after` by applying the proposed edit(s) in
memory (reuse the U1/U2 apply logic — extract a pure `applyEdits(content, edits)`
helper so the loop can compute `after` without writing), and emit both on
`tool_proposed`. `ToolCard` already renders the diff when `after` is present —
**no web change.**
**Execution note:** test-first on the pure `applyEdits` helper.
**Test scenarios:**
- `edit_file` proposal carries `before` (current file) and `after` (post-edit),
  matching what the executed edit produces.
- `multi_edit` proposal `after` reflects all edits.
- A non-file tool (`grep`) proposal carries no `before`/`after`.
**Verification:** `loop.test.ts` asserts before/after on edit proposals; the live
diff renders for an `edit_file` in the dockerized UI.

---

### Phase B — Self-verifying loop

### U5. `run_command` tool (run tests/build, capture output)

**Goal:** Give the agent a first-class way to run tests/build and read results.
**Dependencies:** none (independent of Phase A).
**Files:** `packages/schema/src/tools.ts`, `apps/agent/src/tools/run.ts` (new),
`apps/agent/src/tools/index.ts`, `apps/agent/src/tools/tools.test.ts`.
**Approach:** Schema `run_command: { command, timeoutMs? }`, `side-effecting`.
Spawn `sh -c <command>` in the workspace cwd (mirror `bash`), capture combined
stdout+stderr (truncate to a cap) and the exit code, honor `ctx.signal` (cancel)
and a timeout. Return `…\n[exit N]`. Distinct from `bash` so the UI/policy can
treat "run a verification command" as its own card and the U6 allowlist can
target it.
**Test scenarios:**
- Happy: a passing command returns stdout + `[exit 0]`.
- Failure: a failing command returns stderr + `[exit 1]`.
- Edge: timeout terminates the child and reports it; abort signal cancels.
**Verification:** unit tests green; `run_command "node -e ..."` returns expected
output + exit marker.

### U6. Self-verify loop: prompt, step budget, and per-session auto-approve allowlist

**Goal:** The model edits, runs tests, reads failures, edits again, and stops
when green — without a gate on every test run.
**Requirements:** PRD §3b agent loop; the "self-verification loop" expectation.
**Dependencies:** U1, U5.
**Files:** `apps/agent/src/model.ts` (system prompt), `apps/agent/src/loop.ts`
(step budget; allowlist plumbing), `apps/agent/src/intercept.ts` (honor
allowlist at the gate), `packages/schema/src/schema.ts` (extend the `approve`
control payload with optional `alwaysAllow`), `apps/agent/src/intercept.test.ts`,
`apps/agent/src/loop.test.ts`.
**Approach:**
- **Prompt:** instruct the agent to make a plan, prefer `edit_file`/`multi_edit`
  over `write_file`, and after any edit run the project's tests/build with
  `run_command` and fix failures before declaring done.
- **Allowlist:** an `approve` control may carry `alwaysAllow: true`; `resolveTool`
  records `(sessionId, toolName)` in an in-memory + event-backed allowlist; on a
  later side-effecting proposal whose tool is allowlisted, skip the gate and run.
  Keep it per-session and per-tool-name (coarse but safe enough; finer scoping
  deferred).
- **Step budget:** keep the `maxSteps` ceiling but raise the default and make a
  verify loop count fairly (an edit + a test run + a fix is several steps); the
  cap stays a runaway backstop, not the normal stop.
**Execution note:** the allowlist is the riskiest behavior — test-first.
**Test scenarios:**
- After an `approve {alwaysAllow:true}` for `run_command`, a second
  `run_command` proposal auto-runs (no gate wait) and the session does not enter
  `awaiting-approval` the second time.
- Without `alwaysAllow`, the second `run_command` still gates.
- A multi-step scripted run (edit → run_command(fail) → edit → run_command(pass)
  → message) completes with the expected event order and ends `completed`.
- The step cap still force-stops a non-terminating loop.
**Verification:** integration test of the allowlist + a real dockerized run where
the agent edits a file and runs tests to green (manual smoke, recorded).

---

### Phase C — Planning surface

### U7. `todo_write` tool + `plan` projection + TodoPanel

**Goal:** A live, model-maintained checklist.
**Dependencies:** none.
**Files:** `packages/schema/src/schema.ts` (+`'plan'` EVENT_TYPE),
`packages/schema/src/zod.ts` (`plan` payload), `apps/agent/src/tools/index.ts`
(`todo_write`), `apps/agent/src/context.ts` (project latest plan into context so
the model sees its own todos), `apps/web/src/lib/trace.ts`,
`apps/web/src/components/TodoPanel.tsx` (new),
`apps/web/src/components/SessionDetail.tsx`, plus tests for each.
**Approach:** Schema `todo_write: { items: [{ text, status: 'pending'|'in_progress'|'done' }] }`,
`read-only` (it only records intent). The tool appends a `plan` event; the latest
`plan` event is the current list. `buildTrace` exposes the latest plan; the web
renders a `TodoPanel` pinned in the session detail. `buildContext` includes the
latest plan as a system note so the agent keeps it updated.
**Test scenarios:**
- `todo_write` appends a `plan` event with validated items; web renders the items
  with per-status styling.
- The latest `plan` supersedes earlier ones in the panel.
- `buildContext` includes the current todos when present, omits when absent.
**Verification:** schema/agent/web unit tests green; the panel updates live in the
dockerized UI as the agent calls `todo_write`.

---

### Phase D — Subagents

### U8. `task` subagent tool (scoped child loop)

**Goal:** Delegate a bounded sub-task to a child loop with a restricted toolset
and isolated context, summarizing back.
**Requirements:** PRD §3b state/loop; modern subagent expectation.
**Dependencies:** U1, U5 (so the child has useful tools).
**Files:** `apps/agent/src/subagent.ts` (new), `apps/agent/src/tools/index.ts`,
`packages/schema/src/schema.ts` (+`'subagent_started'`,`'subagent_result'`),
`packages/schema/src/zod.ts`, `apps/web/src/lib/trace.ts`,
`apps/web/src/components/ToolCard.tsx`, plus tests.
**Approach:** Schema `task: { description, prompt, tools?: string[] }`,
`side-effecting` (gated — it can run side-effecting child tools). Impl runs an
inner bounded loop (own `buildContext` seeded by `prompt`, a toolset filtered to
`tools` or a read-only default, its own small step cap) using a child
`ModelDriver`. Child steps are appended as events tagged with the parent
`toolCallId` (`subagent_started` then the child's own `tool_*`/`message` events
carrying `parentToolCallId`, then `subagent_result` with the summary). The
parent receives the summary as its `tool_result`. No new process/port — same
daemon. The UI nests child events under the parent tool card.
**Execution note:** characterize the inner-loop boundary first (it reuses
`runSession`-like logic; extract a reusable `runLoop` core if cleaner).
**Test scenarios:**
- A `task` with a scripted child driver records `subagent_started` → child events
  (tagged with `parentToolCallId`) → `subagent_result`, and returns the summary
  as the parent `tool_result`.
- The child toolset is restricted to the requested `tools` (a tool outside the
  set is unavailable to the child).
- Child step cap bounds a non-terminating child.
- Interrupting the parent also stops the child (signal propagation).
- Web nests child events under the parent card.
**Verification:** integration test of the nested run; live dockerized smoke where
a `task` subagent reads files and reports back.
**Risk:** highest-complexity unit. If the inner-loop extraction proves invasive,
land U8 behind the rest and keep the child loop a thin reuse of `runSession`.

---

### Phase E — LSP / diagnostics

### U9. Language-server-backed read-only tools

**Goal:** `diagnostics`, `definition`, `references` (and `hover`) so the agent
gets real type info instead of guessing.
**Dependencies:** none (independent), but most valuable after editing exists.
**Files:** `apps/agent/src/lsp.ts` (new — a minimal LSP client over stdio),
`apps/agent/src/tools/lsp.ts` (new tool wrappers), `apps/agent/src/tools/index.ts`,
`packages/schema/src/tools.ts`, `apps/agent/Dockerfile` (install the language
server), plus tests (mock the LSP client at the tool boundary).
**Approach:** Spawn `typescript-language-server --stdio` (and optionally a
generic server per language) as a child of the daemon; implement the minimal
LSP JSON-RPC handshake (`initialize`, `textDocument/publishDiagnostics`,
`definition`, `references`, `hover`). Tools are **read-only**. The LSP client is
the external boundary (mock it in unit tests, like `model.ts` is excluded);
extract a pure formatter (`diagnostics → string`) that IS unit-tested.
**Test scenarios (on the pure layer):**
- Diagnostics formatter renders `path:line:col severity message`.
- definition/references formatters render `path:line` lists.
- The tools are classified `read-only`.
**Verification:** pure-layer unit tests green; a dockerized smoke where
`diagnostics` on a file with a type error reports it. Confirm the agent image
still builds with the language server installed.
**Risk:** runtime weight (a language server per container) and process lifecycle;
gate behind a feature flag (`STEER_LSP=1`) so a plain `docker compose up` is
unaffected if the server is absent.

---

### Phase F — MCP client

### U10. MCP client: connect servers, register their tools (gated)

**Goal:** The agent can call external MCP tools (issue trackers, DBs, browsers)
within the same interception model.
**Requirements:** "MCP is table stakes" (research); not a coding-agent SDK.
**Dependencies:** none, but lands after the core loop so MCP tools have a verify
context.
**Files:** `apps/agent/src/mcp.ts` (new — `@modelcontextprotocol/sdk` stdio/SSE
client + config loader), `apps/agent/src/model.ts` (merge dynamic MCP tools into
`toolSet`), `apps/agent/src/tools/index.ts` (dispatch `mcp:<server>/<tool>`),
`apps/agent/Dockerfile`/compose (config), plus tests.
**Approach:** Read an MCP config (env or `mcp.json`), connect outbound (stdio for
local servers, SSE for remote), list each server's tools, and register them with
namespaced names (`mcp:<server>/<tool>`). `classifyTool` already defaults unknown
names to `side-effecting`, so MCP tools gate by default — no policy change
needed. The model's `toolSet` becomes `static ∪ dynamic(MCP)`. Outbound only —
portless holds.
**Test scenarios:**
- A fake MCP server's tools register with namespaced names and appear in the
  toolset.
- An MCP tool call dispatches to the client and returns its result as a
  `tool_result`.
- MCP tools classify `side-effecting` (gated) by default.
- Missing/unreachable config degrades gracefully (no MCP tools, agent still runs).
**Verification:** unit tests with a stub MCP server; a dockerized smoke against a
trivial local MCP server. Confirm no inbound port is opened.
**Risk:** trust surface — keep MCP tools gated; document that operators approve
each MCP call (or allowlist per U6).

---

### Phase G — Cross-cutting UI, image, docs, end-to-end

### U11. Web surface for the new tools + agent image build

**Goal:** Tool cards, diffs, todo panel, subagent nesting, and run-command output
all render; the agent image still builds with new runtime deps.
**Dependencies:** U3, U5, U7, U8 (UI), U9/U10 (Dockerfile).
**Files:** `apps/web/src/lib/design.ts` (`toolIcon` for new tools),
`apps/web/src/components/ToolCard.tsx` (run-command output block; nested subagent),
`apps/web/src/components/SessionDetail.tsx` (mount `TodoPanel`),
`apps/web/src/lib/trace.ts`, the matching `*.test.tsx`/`*.test.ts`,
`apps/agent/Dockerfile`.
**Approach:** Most new tools render through the existing generic `ToolCard`
(args + result + diff). Add icons, the run-command result styling, the nested
subagent affordance, and mount the `TodoPanel`. Update the Dockerfile to install
the language server + MCP runtime; verify the image builds.
**Test scenarios:**
- A `run_command` tool item renders its output + exit marker.
- A subagent tool card shows its nested children.
- New tool names get a non-`wrench` icon.
- `toolStatusMeta`/`sessionStatusMeta` still cover every status (no `.color` crash).
**Verification:** web suite 100%; `docker compose up --build` boots clean with the
updated agent image (real-run smoke).

### U12. End-to-end coding-agent verification

**Goal:** Prove the whole loop on a real task against the dockerized stack.
**Dependencies:** U1–U11.
**Files:** `docs/changelog/` entry; an e2e checklist (and a Playwright or
scripted DB-assertion harness where practical) under `apps/web/e2e/` or
`docs/`.
**Approach:** Drive a real session (via `./steer` CLI or the UI): "fix the failing
test in X" → agent makes a plan (`todo_write`), `edit_file`s, `run_command`s the
tests, reacts to failure, edits again, re-runs to green, summarizes. Assert the
event log shows the plan, the surgical edits with diffs, the test runs, and a
`completed` status. Confirm interception still works (approve/swap/edit/reject on
an edit; auto-approve on `run_command`).
**Test expectation:** an integration/e2e harness that asserts the event sequence
from real DB reads (per repo rule: no inferred outputs); plus a recorded manual
smoke for the live UI.
**Verification:** the recorded run shows plan → edits → verify-loop → green →
summary, with diffs and interception intact.

---

## Scope boundaries

**In scope:** the six capability areas above and their flow through the existing
event-log/interception/sync model, with tests at the repo bar and a real-run
verification.

### Deferred to follow-up work
- Fine-grained auto-approve scoping (per-command-pattern rather than per-tool-name).
- Multi-language LSP beyond TypeScript (the U9 client is structured to extend).
- Parallel subagents / a subagent pool (U8 is sequential, in-process).
- An MCP **server** surface (we only ship a client).
- Streaming token output / `tool_stdout_delta` live streaming (separate from this
  plan; the event type exists but is unused).

### Outside this product's identity
- Replacing the hand-rolled loop with a coding-agent SDK (PRD-forbidden).
- Opening any inbound port on the agent container (PRD-forbidden).

---

## Risks & mitigations

- **Docker image bloat / build breakage** (LSP + MCP runtimes): gate LSP behind
  `STEER_LSP=1` and make MCP optional; U11 verifies `docker compose up --build`
  still works with and without them.
- **Verify-loop cost** (each test run is inference + a command): the U6 step
  budget stays a backstop; the auto-approve allowlist avoids gate stalls.
- **Subagent complexity** (U8): land last; keep the child loop a thin reuse of
  the parent; bound it with its own step cap and signal propagation.
- **Shared test DB**: all DB-backed tests use a throwaway Postgres, never the
  live `:54321` stack (this has already bitten the running stack twice this
  session).
- **Coverage bar**: external boundaries (LSP client, MCP client, model driver)
  are excluded from coverage like `model.ts`/`db.ts` already are; the pure layers
  (apply-edits, diagnostics formatter, allowlist, plan projection) are fully
  tested.

---

## Verification strategy (summary)

Per unit: package `test:coverage` at 100% lines/functions/statements (branches
≥90) against a throwaway Postgres for DB-backed suites; `pnpm -r typecheck`
clean. System-level: `docker compose up --build` boots clean; one recorded
real-run where the agent plans, edits surgically, runs tests, self-corrects to
green, and summarizes — with interception (approve/swap/edit/reject + auto-approve)
intact.
