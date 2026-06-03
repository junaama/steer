---
name: Sync Coding Agent
last_updated: 2026-06-02
---

# Sync Coding Agent Strategy

## Target problem

The reviewer has to decide, in a few minutes, whether this candidate
genuinely understands sync-driven architecture and can honor a dense set of hard
constraints — or whether they cut a corner that disqualifies the whole submission.
That's hard to verify because a build can *look* live and polished while faking sync
(polling, websockets, optimistic local state) or quietly breaking a rule (Next.js, an
exposed agent port, a coding-agent SDK, a `docker compose up` that doesn't come up).
The failure mode to avoid: being the candidate who couldn't follow the instructions.

## Our approach

Win on sync correctness, type-safety, and clean factoring. Make Postgres the single
source of truth and treat the UI and the agent as pure projections of synced state
through Electric SQL + Tanstack DB — never a websocket, never local state pretending to
be live — so every hard constraint is *provably* honored and `docker compose up` just
works on the reviewer's first try.

## Who it's for

**Primary:** the reviewer — they're hiring this submission to quickly and
confidently verify that the candidate can build a correct sync-driven system and follow
exacting constraints, without having to debug the environment themselves.

## Key metrics

- **Clean cold-start** — `docker compose up` from a fresh clone + `.env` brings the whole
  stack (server/UI, Postgres, Electric, agent container) to working with zero extra steps.
  Binary; checked on a clean machine.
- **Sync freshness** — latency from an agent event (tool call, thinking token, message)
  written server-side to it appearing in the UI, via Electric + Tanstack only. Live-time,
  sub-second.
- **Constraint compliance** — count of PRD hard-constraints honored (no Next.js, no
  websockets, no coding-agent SDK, agent container exposes no ports, all collections synced
  via Electric+Tanstack, real auth boundary). Target = all; any miss is disqualifying.
- **Type-safety** — TS strict across UI, server, and agent with no `any` escape hatches at
  boundaries; typecheck/build passes green.
- **Session lifecycle correctness** — create / interrupt / continue / rename / delete all
  work and reflect through sync, correctly auth-scoped (a user sees only their own sessions).

## Tracks

### Sync substrate

Postgres + Electric SQL + Tanstack DB as the one read path; every collection (sessions,
events, messages, tool calls) flows through it to the UI.

_Why it serves the approach:_ this is the thing being evaluated — sync correctness is the headline.

### Agent daemon

The headless agent loop (inference calls, state, event emission) running in its own
container: connects out only, exposes no ports, picks up sessions via sync, streams events back.

_Why it serves the approach:_ proves a real agent built without an SDK, and respects the no-ports constraint.

### Auth & authorization boundary

Login/logout, per-user session scoping, and request authorization on both the API and sync access.

_Why it serves the approach:_ an explicit PRD requirement and a common silent failure; sync makes data-layer authz load-bearing.

### Cold-start DX & docs

The one-shot `docker compose up`, `.env` config, README, and Loom demo.

_Why it serves the approach:_ "submissions that don't build are rejected" — the reviewer's first five minutes decide everything.

## Milestones

- **2026-06-02** — Submission to K-Mistele: `docker compose up` works end-to-end, full
  Electric+Tanstack sync, auth boundary, and a Loom walkthrough of architecture + data/security model.

## Not working on

- Multi-user collaboration, teams, or sharing beyond per-user session ownership.
- Horizontal scaling / production hardening beyond a correct auth boundary.
