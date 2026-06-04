---
status: completed
type: feat
created: 2026-06-03
depth: deep
title: "feat: cwd-routed workspace — steer binds to your directory, broad-rooted daemon serves it"
related:
  - docs/plans/2026-06-03-002-feat-environment-binding-run-anywhere-plan.md
---

# feat: cwd-routed workspace ("steer runs where you are")

## Summary

Today the natural command — `./steer "fix the test"` against `docker compose up` —
runs the agent in the container's `/workspace`, where `~` is the container's
`/root` and the file tools are sandboxed to `/workspace`. A user who runs
`./steer "move steering.md to ~/dev"` gets an agent that can't reach their files,
flails, and stops. 002 added an **opt-in** local-daemon path (`steer-agent --env`)
that fixes this, but the default is unchanged and undiscoverable.

This plan makes the **default** do what the user expects:

1. **`./steer` binds the session to the directory it was called from.** Run it in
   `/dev/projectA` and the agent operates on `/dev/projectA`'s files — no `--env`,
   no manual daemon. The CLI captures `cwd` and sends it as the session's
   **working directory**.
2. **The daemon is broadly rooted.** Instead of a per-project sandbox, a daemon
   has a **root** and runs each session in that session's working directory
   *within* the root. The default container daemon's root is a broad mount (the
   "root project" / a configurable machine root), so it can serve any working
   directory under it.
3. **A session can request scope beyond its cwd.** Because the sandbox confines to
   the daemon's (broad) root rather than the session's cwd, a task that needs a
   sibling directory can reach it — up to the root — instead of being trapped.

This builds directly on 002's primitives (`environment` routing + single-owner
`claimed_by` claiming): `environment` still decides *which* daemon runs a session;
the new `workdir` decides *where within that daemon's root* it runs. Nothing about
routing/claiming changes.

> **This plan widens the agent's filesystem reach by design.** A broadly-rooted
> daemon — and a sandbox keyed to that broad root — means a session can read and
> (with approval) write anywhere under the root, and `bash` is an uncontained real
> shell. That is the user's explicit intent ("if the session needs access outside
> that scope it can just request it"). The single most important decision below
> (**D1**) is *what the default root is* — and the recommendation is a configurable
> root that does **not** default to host `/`.

---

## Problem frame & current state

- `apps/agent/src/workspace.ts` — `resolveWorkspaceRoot(env, cwd)` returns
  `STEER_WORKSPACE_ROOT || cwd()`. It is **per-daemon**: one root for every session
  the daemon runs. The container sets `STEER_WORKSPACE_ROOT=/workspace`.
- `apps/agent/src/tools/index.ts` — every file tool calls
  `safeJoin(ctx.workspaceRoot, path)` which refuses traversal outside
  `workspaceRoot`. `bash` (`tools/index.ts:127`) spawns a real shell with
  `cwd: workspaceRoot` and **no** containment.
- `apps/agent/src/daemon.ts` — `defaultRunOne` computes one `workspaceRoot` per
  daemon and passes it to `runSession` for every session.
- `apps/cli/src/commands.ts` — `run()` sends `{ id, title, task, model,
  environment }`; no notion of a working directory.
- `apps/server/src/writes.ts` — sessions insert accepts `{ id, title, task?,
  model? }` and injects `user_id`; `environment` was added by 002.
- `docker-compose.yml` — agent mounts `${WORKSPACE_DIR:-./workspace}:/workspace`
  and sets `STEER_WORKSPACE_ROOT=/workspace`.

The gap: there is **no per-session working directory**, so "run where the CLI was
called" is unrepresentable, and the daemon root doubles as both the sandbox
boundary *and* the operating directory.

---

## Requirements traceability (origin: user direction, 2026-06-03)

| Requirement (user's words) | Addressed by |
|---|---|
| "running the steer cli is routed to your workspace … cwd is where the env is auto set" | U4 CLI captures `cwd` → session `workdir` |
| "running steer in /dev/projectA starts that as the root" | U3 agent runs the session in its `workdir` |
| "update the docker container … routes the workspace to the root of the machine … starts the docker in the root project" | U5 broad, configurable daemon root (D1) |
| "if the session needs access to an environment outside that scope it can just request it" | U3 sandbox confines to the daemon **root**, not the session cwd |
| Keep 002 routing intact (which daemon claims a session) | U1–U5 leave `environment`/`claimed_by` untouched |

---

## Key technical decisions

**D1 — Default daemon root = host `/` (DECIDED).** The daemon roots at the machine
root. The container mounts host `/` (`WORKSPACE_DIR=/`, `STEER_WORKSPACE_ROOT=/`) and
a host daemon roots at `/`, so the agent — and its uncontained `bash` — can reach
anywhere, and any `cwd` the end user runs `steer` from is automatically a valid
working directory under the root. **Rationale: Steer is built for release to other
people on their own machines** (see memory: steer-is-for-release-machine-agnostic) —
a default seeded from *this* developer's layout (`~/dev`, `$HOME`) is a "works on my
machine" retrofit that breaks for every other user. Host `/` is the only default
that is machine-agnostic: it works on any fresh machine without assuming a directory
structure. The root stays configurable via `WORKSPACE_DIR`/`STEER_WORKSPACE_ROOT` for
anyone who wants to narrow it. The broad reach is intentional and documented, not
incidental.

**D2 — `workdir` is client-supplied but root-confined.** The CLI sends an absolute
`cwd`. The daemon resolves the session's operating directory as: if `workdir` is
set **and** resolves inside the daemon's root, use it; otherwise fall back to the
root. A `workdir` outside the root is ignored (not an error) — a laptop session
routed to the container can't point at a path the container doesn't have. The
server stores `workdir` verbatim (like `environment`); confinement is enforced
daemon-side where the real filesystem is.

**D3 — Sandbox root = daemon root; tool default dir = session workdir.** Split the
two concerns `resolveWorkspaceRoot` currently conflates. `ToolContext` gains a
`root` (sandbox boundary, = daemon root) alongside `workspaceRoot` (the session's
operating dir, = workdir). `safeJoin` confines to `root`; relative paths resolve
against `workspaceRoot`. This is what lets a `/dev/projectA` session read
`/dev/projectB` ("request broader scope") while still refusing to escape the root.
`bash` keeps `cwd: workspaceRoot` (the session dir) and remains uncontained — call
that out in docs, unchanged from today.

**D4 — Backward compatibility.** A session with no `workdir` (web "New session",
older clients) behaves exactly as today: operating dir = daemon root = sandbox
root. `docker compose up` with the default `WORKSPACE_DIR` still works; only the
default mount target widens (D1).

---

## High-level design

```
CLI (cwd=/dev/projectA)                Daemon (root = /host or ~/dev)
  steer "…"  ──insert workdir=/dev/projectA──▶  claim (002, by environment)
                                               run session:
                                                 root        = daemon root (sandbox)
                                                 workspaceRoot = workdir ∩ root
                                                 tools: safeJoin(root, …), cwd=workspaceRoot
```

*Directional only — not implementation spec.* `environment` (002) still selects the
daemon; `workdir` selects the directory within its root.

---

## Implementation units

### U1. Schema: session `workdir` column + migration

**Goal:** Persist the directory a session targets.
**Requirements:** cwd-auto-route.
**Files:** `packages/schema/src/schema.ts` (add `workdir text`),
`packages/schema/src/zod.ts` (insert accepts optional `workdir`),
`apps/server/drizzle/0004_*.sql` (generated migration),
`packages/schema/src/zod.test.ts` (test).
**Approach:** Add a nullable `workdir` column mirroring how 002 added
`environment` (nullable text, no index needed — it's read with the session row,
not filtered on). Regenerate the drizzle migration.
**Patterns to follow:** 002's `environment` column + `0003_*.sql`.
**Test scenarios:**
- `sessionInsertSchema` / event payloads accept a session row with `workdir` set and with it absent (→ null).
- Migration applies cleanly on a fresh DB (covered by the server lifecycle suite's migrate step).
**Verification:** `pnpm --filter @steer/schema test` green; migration present and applies.

### U2. Server: accept `workdir` on session insert

**Goal:** Let a client set `workdir` at create time; keep it untrusted-but-stored.
**Requirements:** cwd-auto-route.
**Dependencies:** U1.
**Files:** `apps/server/src/writes.ts`, `apps/server/src/prd-session-lifecycle.test.ts`.
**Approach:** Extend the sessions-insert zod object with `workdir: z.string().optional()`; pass through to the insert (verbatim, like `environment`). No path validation server-side (D2 — the daemon validates against its real root).
**Patterns to follow:** the `environment` pass-through added by 002 in `applyWrite`.
**Test scenarios:**
- Insert with `workdir` set → row persists it (read back from Postgres).
- Insert without `workdir` → column is null.
- `workdir` does not leak cross-user (existing per-user isolation still holds).
**Verification:** lifecycle suite green against the throwaway Postgres.

### U3. Agent: per-session workspace + root-scoped sandbox

**Goal:** Run each session in its `workdir`, sandboxed to the daemon's (broad) root.
**Requirements:** "starts that as the root"; "request access outside that scope."
**Dependencies:** U1.
**Files:** `apps/agent/src/workspace.ts` (add `resolveSessionWorkspace(root, workdir)`),
`apps/agent/src/tools/index.ts` (`ToolContext.root` + `safeJoin(root, …)`, default dir = `workspaceRoot`),
`apps/agent/src/tools/edit.ts`, `apps/agent/src/tools/lsp.ts` (same `safeJoin` split),
`apps/agent/src/loop.ts` / `apps/agent/src/intercept.ts` (thread `root` through the tool context),
`apps/agent/src/daemon.ts` (`defaultRunOne` resolves root once, session dir per session),
`apps/agent/src/workspace.test.ts`, `apps/agent/src/tools/tools.test.ts`.
**Approach:** Keep `resolveWorkspaceRoot` as the **root** resolver. Add
`resolveSessionWorkspace(root, workdir)`: returns `workdir` when it resolves inside
`root`, else `root` (D2). `ToolContext` carries both `root` (sandbox) and
`workspaceRoot` (operating dir). `safeJoin` takes the root; relative paths resolve
against the operating dir. `bash` cwd stays the operating dir.
**Execution note:** Characterize current sandbox behavior (the existing `safeJoin`
"escapes the workspace" tests) before splitting root vs operating dir, so the
confinement guarantee is preserved.
**Test scenarios:**
- `resolveSessionWorkspace('/root', '/root/projectA')` → `/root/projectA`; `('/root', '/etc')` → `/root` (outside root ignored); `('/root', undefined)` → `/root`.
- A session with `workspaceRoot=/root/projectA`, `root=/root`: `read_file('../projectB/x')` succeeds (sibling under root — "request broader scope"); `read_file('../../etc/passwd')` throws "escapes the workspace" (root boundary holds).
- Relative paths (`list_dir('.')`) resolve against the session dir, not the root.
- Backward compat: no `workdir` → operating dir == root == today's behavior (existing tool tests still pass).
**Verification:** agent suite green; the confinement test still refuses paths above the root.

### U4. CLI: capture cwd as the session `workdir` by default

**Goal:** `./steer "…"` auto-binds to the directory it ran in.
**Requirements:** "cwd is where the env is auto set."
**Dependencies:** U2.
**Files:** `apps/cli/src/commands.ts` (send `workdir: cwd()` on create; injectable for tests),
`apps/cli/src/cli.ts` (optional `--workdir <path>` override + help),
`apps/cli/src/api.ts` (`createSession` carries `workdir`),
`apps/cli/src/commands.test.ts`, `apps/cli/src/cli.test.ts`.
**Approach:** Default `workdir = process.cwd()` (inject `cwd` via `Ctx` like the
other side effects so tests stay hermetic). `--workdir` overrides. Leave `--env`
(002 daemon routing) as-is — `workdir` and `environment` are orthogonal (which
daemon vs. which directory). Update `steer`'s help to explain "runs in the
directory you call it from."
**Test scenarios:**
- `run()` sends `workdir` = the injected cwd; `--workdir /x` overrides it.
- `--env` still routes independently of `workdir`.
- Follow-up (`--session`) does not resend `workdir` (the original binding holds).
**Verification:** CLI suite green; a real `./steer` shows the session's `workdir` in the DB.

### U5. Docker: broad, configurable daemon root + docs/changelog

**Goal:** Ship a default container daemon rooted broadly enough to serve any cwd,
without defaulting to whole-machine access.
**Requirements:** "routes the workspace to the root of the machine / root project."
**Dependencies:** U3.
**Files:** `docker-compose.yml` (default `WORKSPACE_DIR` / `STEER_WORKSPACE_ROOT`
to a broad bounded dir per D1; comment the host-`/` opt-in), `README.md`
(cwd-routing walkthrough; security note), `docs/changelog/`.
**Approach:** Per D1, default the mount to host `/` (`WORKSPACE_DIR=/`,
`STEER_WORKSPACE_ROOT=/`) so a freshly-pulled stack on any machine serves every
directory the end user might `cd` into. Keep `WORKSPACE_DIR`/`STEER_WORKSPACE_ROOT`
overridable for anyone who wants to narrow the root. Keep `docker compose up`
working with zero further config. Document the trust model: the agent can reach the
whole root and `bash` is an uncontained real shell.
**Test scenarios:** `Test expectation: none` — compose/docs change. Covered
indirectly by the lifecycle/run e2e using the resolved root.
**Verification:** `docker compose --env-file .env.local up` boots; a container
session with `workdir` under the root operates on those files (live smoke).

---

## Risks & mitigations

- **Broad filesystem reach (D1/D3).** The agent can read across the root and, with
  approval, write; `bash` is uncontained. *Mitigation:* configurable root that does
  not default to `/`; the existing U8 approval gate still pauses side-effecting
  tools; document the trust model.
- **Client-supplied `workdir`.** *Mitigation:* daemon-side confinement to the root
  (D2) — a session can never operate outside the daemon's root regardless of what
  the client sends.
- **Sandbox split regression.** Conflating then splitting `root` vs operating dir
  risks loosening confinement. *Mitigation:* characterization-first (U3 execution
  note); keep the "escapes the workspace" tests and add the sibling-access + root-
  boundary cases.
- **Backward compatibility.** *Mitigation:* D4 — no `workdir` reproduces today's
  behavior exactly; the web flow is unaffected.

---

## Scope boundaries

**In scope:** per-session `workdir`, cwd auto-capture in the CLI, root-vs-operating-
dir sandbox split, a broad configurable default container root, docs.

### Deferred to follow-up work
- Auto-starting/managing a local daemon from the CLI (the "auto-start daemon"
  approach) — this plan keeps daemon lifecycle manual (002) and only changes *where*
  a claimed session runs.
- A first-class "request scope" tool/prompt affordance — D3 makes broader paths
  reachable implicitly; an explicit "escalate scope" UX is a later refinement.
- Sandboxing `bash` itself (namespaces/chroot) — out of scope; it stays an
  uncontained real shell as today.
