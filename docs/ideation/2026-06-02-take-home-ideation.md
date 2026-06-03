---
date: 2026-06-02
topic: take-home
focus: winning the HumanLayer take-home (sync headless coding agent + reactive UI)
mode: repo-grounded
---

# Ideation: Winning the HumanLayer take-home

## Grounding Context

**Codebase context:** Greenfield — only `PRD.md`, `STRATEGY.md`, and `perplexity-conversation.md` exist; no code yet. Mandated stack: TypeScript everywhere; Postgres + Electric SQL + TanStack DB for sync; docker-compose with containers for server/UI, Postgres, Electric, and a **portless** agent container (outbound only). Banned: Next.js, websockets, pre-built coding-agent SDKs. Allowed: Vercel AI SDK, raw LLM provider SDKs.

**Strategy (verbatim approach):** "Win on sync correctness, type-safety, and clean factoring. Make Postgres the single source of truth and treat the UI and the agent as pure projections of synced state through Electric SQL + TanStack DB — never a websocket, never local state pretending to be live — so every hard constraint is provably honored and `docker compose up` just works." Tracks: Sync substrate · Agent daemon · Auth & authorization boundary · Cold-start DX & docs. Failure mode to avoid: the candidate who "couldn't follow the instructions."

**External research (load-bearing facts):**
- Electric is **read-path only**; the write path is your own REST API (client POST → server writes Postgres → Electric streams it back). No websockets anywhere.
- Electric is **public by default**; secure via Proxy Auth (server injects `table/columns/where`) or Gatekeeper JWT (signed shape definition). Add `Vary: Authorization` or a cache can serve one user's rows to another; force a full reload on logout.
- TanStack `electricCollection.onInsert` returns `{txid}` captured **inside** the mutation transaction; `awaitTxId` blocks until that exact tx re-appears in the stream (kills optimistic flicker). Pitfall: txid taken outside the tx → `awaitTxId` stalls forever.
- Control-plane-via-data-plane: an interrupt is just a row that syncs into the agent, which halts. No separate channel.
- Agent loop without an SDK: Vercel AI SDK `streamText` + tools (`read_file`/`write_file`/`bash`/`list_dir`) + `stopWhen(stepCountIs(n))`; `onStepFinish` → persist each step as an event row. `needsApproval` enables HITL gating.
- Common rejections: faked sync (polling in network tab), broken compose (missing `wal_level=logical`, bad healthcheck ordering), `ELECTRIC_INSECURE` left on, agent container exposing ports, client-controlled WHERE (data leak). Rewards: provable two-window real-time sync, end-to-end TS types, a tight ~90s Loom.

## Topic Axes

- sync-substrate — Electric shapes, write path, schema, event modeling, txid/optimistic
- agent-daemon — agent loop, tool execution, event emission, interrupt/continue, sandbox
- auth-boundary — login, per-user scoping, securing the Electric proxy/gatekeeper
- session-ux — TanStack collections, optimistic writes, live viewing, session CRUD, multi-window
- eval-surface — docker compose one-shot, README, Loom demo, type-safety proof, constraint-compliance proof

> Headline finding: **all 6 ideation frames independently converged** on ideas #1–#5. #1 and #6 are upstream of everything else — committing to them first makes the rest materially cheaper. That is the critical path.

## Ranked Ideas

### 1. Append-only event log as the one writable truth
**Description:** One immutable `events` table (`session_id, seq, type, payload`). The agent only ever *appends* rows; `messages`, `tool_calls`, and `status` are projections/folds over that log. Live stream, multi-window viewing, interrupt-audit, and resume all fall out of this one decision — no separate state store, no websocket.
**Axis:** sync-substrate
**Basis:** `direct:` STRATEGY — "treat the UI and the agent as pure projections of synced state"; `external:` AI-SDK `onStepFinish` persists each step as a row.
**Rationale:** Makes "UI and agent are projections" literally true at the schema level and makes the two-window demo trivially correct. Produced by every one of the 6 frames.
**Downsides:** Folding status from a log needs care (ordering, seq monotonicity); slightly more query work than a mutable `status` column.
**Confidence:** 95%
**Complexity:** Medium
**Status:** Unexplored

### 2. Secure-Electric proxy (server-injected WHERE + `Vary: Authorization` + reload-on-logout)
**Description:** All shape traffic routes through one proxy that verifies the session/JWT and injects `where user_id = $sub` — the client never authors a filter. Add `Vary: Authorization` so a cache can't leak rows across users; force a full reload on logout to flush synced state.
**Axis:** auth-boundary
**Basis:** `external:` Electric is public-by-default; Proxy/Gatekeeper auth injects the `where` server-side; `direct:` "no auth on the sync layer" is a named rejection reason and auth is a PRD hard requirement.
**Rationale:** Authorization *becomes* the sync query — security model and data model are the same thing. Defuses the two most catastrophic disqualifiers (unsecured Electric, client-controlled WHERE) in one auditable file.
**Downsides:** Gatekeeper-JWT adds moving parts; the simpler server-injected-WHERE proxy is the tonight-safe choice.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 3. Control-plane-via-data-plane (interrupt / approve are just rows)
**Description:** No control channel. The UI writes an `interrupt` (or `control`) row through the normal write path; Electric syncs it *into* the portless agent, whose loop checks it at each `onStepFinish` boundary and halts (then appends an `interrupted` event). HITL approval works identically via a `pending_approval` row + AI-SDK `needsApproval`.
**Axis:** agent-daemon
**Basis:** `external:` Electric's own AI-apps-on-sync pattern; `direct:` PRD requires interrupt + bans websockets; the agent container is portless.
**Rationale:** Turns the hardest constraint (portless, no inbound, no websocket) into the most elegant demo: a UI button with zero direct connection still stops the agent instantly.
**Downsides:** Interrupt latency is bounded by step granularity (halts between steps, not mid-token).
**Confidence:** 92%
**Complexity:** Low–Medium
**Status:** Unexplored

### 4. Optimistic session UX via `awaitTxId` (no local-state-faking)
**Description:** Session CRUD and message-send apply optimistically in TanStack DB, then reconcile against the authoritative synced row at the precise txid — like client-prediction reconciled on the server tick. Centralize it in one helper so the documented footgun (txid taken *outside* the tx → stall) can't recur.
**Axis:** session-ux
**Basis:** `external:` `onInsert` returns `{txid}` captured inside the mutation tx; `awaitTxId` blocks until it syncs. `direct:` STRATEGY — "never local state pretending to be live."
**Rationale:** The difference between provable real-time sync and a UI that flickers or hangs; the mechanism that lets you honestly claim no local state is faking liveness.
**Downsides:** The txid-inside-transaction discipline is subtle; one misplaced query breaks every write — must be tested.
**Confidence:** 85%
**Complexity:** Low–Medium
**Status:** Unexplored

### 5. Two-window live demo + one-command cold-start + seed=fixture=Loom
**Description:** Engineer the evaluation surface as a deliverable: (a) healthcheck-gated compose (`wal_level=logical`, `depends_on: condition: service_healthy`, portless agent) for deterministic cold-start; (b) one `seed.ts` that triples as cold-start proof, integration fixture, and Loom script; (c) a side-by-side two-window view where typing in A streams into B with no reload, plus a README line inviting the reviewer to check the Network tab (no polling).
**Axis:** eval-surface
**Basis:** `direct:` rewards = provable two-window sync + tight ~90s Loom + `docker compose up` with no extra steps; rejections = faked sync / broken build.
**Rationale:** Reviewers verify in minutes. Two-window live streaming + zero-config boot front-loads every reward signal and defends against the only guaranteed-fatal outcome ("doesn't build").
**Downsides:** Time-boxed — reserve the last ~45 min for it rather than letting it slip.
**Confidence:** 95%
**Complexity:** Low (but must be scheduled)
**Status:** Unexplored

### 6. Single typed schema spine (drizzle/zod → DB + shapes + collections + tools + props)
**Description:** One `schema.ts` is the only place a type is ever authored — it emits Postgres DDL, Electric shape definitions, TanStack collection types, server write-validation, the Vercel AI-SDK tool input/output schemas, and React props. Rename a column → TypeScript breaks every layer now wrong. A generic `electricCollection<T>()` factory and a generic write endpoint both fall out of this.
**Axis:** sync-substrate (cross-cutting)
**Basis:** `direct:` type-safety is both a STRATEGY metric and a named reward; `external:` drizzle-zod end-to-end typing.
**Rationale:** The single highest-leverage decision — makes every other track cheaper and turns "end-to-end type-safety" into a `grep -r ": any"` that returns nothing.
**Downsides:** Upfront plumbing before any feature ships; pick drizzle + drizzle-zod fast, don't bikeshed.
**Confidence:** 88%
**Complexity:** Medium (one-time)
**Status:** Unexplored

### 7. Crash-only resume = "continue interrupted sessions"
**Description:** The agent keeps no private in-memory state. On boot it reads `MAX(seq)` for in-flight sessions and resumes the loop from the last committed step — directly implementing the PRD's "continue interrupted sessions." Killer Loom beat: `docker kill` the agent mid-run, `docker compose up`, watch it resume exactly where it left off.
**Axis:** agent-daemon
**Basis:** `external:` replication-slot / `?offset=` cursor resume + event-sourcing replay; `reasoned:` if every step is committed before the next, restart is idempotent.
**Rationale:** Satisfies a required PRD capability *and* doubles as the most memorable resilience demo, at near-zero extra cost once #1 exists.
**Downsides:** Requires step-level idempotency (don't double-execute a side-effecting tool on replay) — the one genuinely fiddly part.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Generic `/ingest` write endpoint | Folded into #1/#6 — it's the schema-driven write path, not a separate bet |
| 2 | `electricCollection<T>()` factory | Folded into #6 |
| 3 | Workspace-as-synced-filesystem (repo = a Postgres table) | Scope overrun for tonight; high-wow, flagged as a stretch if time remains |
| 4 | Heartbeat / liveness row | Cut for time — lower impact than #5's demo |
| 5 | Idempotency keys on commands | Production-grade but over-scope tonight |
| 6 | Forkable session = sync shape | Over-scope tonight |
| 7 | Agent-on-reviewer's-laptop proof | Folded into #5 (outbound-only is provable in the Loom) |
| 8 | Polling smell-test / healthcheck boot order | Folded into #5 (cold-start) |
