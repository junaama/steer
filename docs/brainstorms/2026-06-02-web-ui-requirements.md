---
date: 2026-06-02
topic: web-ui
---

# Web UI & Interception Console

## Summary

The reactive web UI for the sync coding-agent: a two-pane app (session sidebar + live session detail) behind a minimal WorkOS AuthKit login. The session view streams the agent's work live as a trace, and any tool call the operator steps into expands into a PR-review-style panel — Approve / Swap (read-only) / Edit args / Cancel, with a diff for file writes. It delivers every PRD-required UI capability plus the live tool-interception headline, with all collections rendered as projections of Electric/TanStack-synced state.

---

## Problem Frame

The PRD requires a reactive UI where a user logs in, lists and navigates their sessions, creates and deletes them, interrupts and continues them, renames them, and watches the agent work in live time. Those are table stakes — and on their own they produce the same submission as every other candidate. The differentiated product (per the interception brainstorm) lets an operator reach into a *running* tool call and redirect it; but a backend that supports interception is invisible unless the UI makes the live tool call graspable and actionable at the exact moment it matters. The UI is where "real-time sync" and "steer a live agent" stop being claims and become something a reviewer can see and do in the first two minutes.

The design tension the UI must resolve: the run is a *live stream*, not a finished artifact, so a static review-everything frame would fight its real-time nature — but the moment of intervention genuinely is a review-and-amend action (especially for a file write). The interface has to be a live trace by default and a review surface precisely when the operator engages a tool call.

---

## Actors

- A1. User / Operator — the authenticated human; creates and manages sessions, watches live runs, and intercepts tool calls.
- A2. Agent run — the headless session whose streamed events (messages, thinking, tool calls, results) the UI renders. Not a UI user; its activity is the content.
- A3. WorkOS AuthKit — external hosted authentication provider handling sign-in/sign-out.

---

## Key Flows

- F1. Authenticate
  - **Trigger:** A logged-out user opens the app.
  - **Actors:** A1, A3
  - **Steps:** User sees a sign-in entry → goes through the WorkOS AuthKit hosted login → returns authenticated → lands in the app shell scoped to their own data.
  - **Outcome:** The user is in, seeing only their sessions; logout later ends the session and flushes synced data.
  - **Covered by:** R1, R2, R3

- F2. Manage sessions (browse, search, create, rename, delete)
  - **Trigger:** Authenticated user works with the sidebar.
  - **Actors:** A1
  - **Steps:** Sidebar lists their sessions → user searches/filters → creates a new one, renames an existing one, or deletes one (with confirm) → list updates optimistically and reconciles on sync.
  - **Outcome:** The user can find and shape their session list fluidly.
  - **Covered by:** R5, R6, R7, R8, R9, R25, R27

- F3. Watch a live run
  - **Trigger:** User opens a running (or starting) session.
  - **Actors:** A1, A2
  - **Steps:** Detail pane streams the trace live (messages, thinking, tool-call cards with streaming results) → status indicator reflects running/awaiting-approval/etc. → trace auto-follows the latest event, with scroll-back available.
  - **Outcome:** The user sees the agent's work as it happens.
  - **Covered by:** R11, R12, R13, R14, R23, R24

- F4. Intercept a tool call (headline)
  - **Trigger:** A running read-only tool the operator judges wrong, or a side-effecting tool awaiting approval.
  - **Actors:** A1, A2
  - **Steps:** Operator engages the tool card → for read-only: Cancel & swap / Edit args / Cancel; for side-effecting: Approve / Swap / Edit args / Reject (with a diff shown for file writes) → the override applies → the card shows the executed (substituted) tool and result, original proposed tool retained as audit → trace continues with no restart and no visible re-plan.
  - **Outcome:** The run is redirected in place; time/tokens saved; the change is auditable.
  - **Covered by:** R15, R16, R17, R18, R19, R20, R21, R22

- F5. Interrupt & continue
  - **Trigger:** User wants to stop a run, then resume it.
  - **Actors:** A1, A2
  - **Steps:** User interrupts the session → status shows interrupted → user continues it later → the run resumes from where it left off.
  - **Outcome:** PRD interrupt/continue is operable from the UI.
  - **Covered by:** R13, R28

- F6. Multi-window live consistency
  - **Trigger:** The same session is open in two windows.
  - **Actors:** A1
  - **Steps:** An event or interception in one window → the other window reflects it live with no manual refresh.
  - **Outcome:** Demonstrable real-time sync (the two-window proof).
  - **Covered by:** R23, R24

---

## Layout

```
┌ Header ───────────────────────────────────────── user@acme  [Logout] ┐
├──────────────┬────────────────────────────────────────────────────────┤
│ SESSIONS     │ Session: "Add auth"            ● awaiting approval       │
│ 🔎 search…   │ ───────────────────────────────────────────────────────│
│ [+ New]      │ 🧠 thinking… I need to patch the login handler          │
│              │ 💬 I'll update src/login.ts.                            │
│ ● Add auth   │ ┌ 🔧 write_file  src/login.ts   ⚠ needs approval ─────┐ │
│   Fix bug ✓  │ │  ── diff ──                                         │ │
│   Deploy  ⏸  │ │  - return null                                      │ │
│   Spike   ✕  │ │  + return session                                   │ │
│              │ │  [Approve] [Swap ▾ read-only] [Edit args] [Reject]  │ │
│              │ └─────────────────────────────────────────────────────┘ │
│              │ ┌ 🔧 grep  "login"   ● running ──────────────────────┐  │
│              │ │  [Cancel & swap → read ▾]   [Edit args]   [Cancel]  │  │
│              │ └─────────────────────────────────────────────────────┘ │
└──────────────┴────────────────────────────────────────────────────────┘

Tool-card status legend:  proposed · pending(⚠ approval) · running(●) ·
                          cancelled(✕) · substituted(↻) · done(✓)
```

---

## Requirements

**App shell & authentication**
- R1. The app is gated: an unauthenticated visitor sees only a sign-in entry point and can access no session data or synced collections.
- R2. Sign-in uses the WorkOS AuthKit hosted login flow; on success the user lands in the app shell, scoped to their own data.
- R3. Logout ends the session and forces a full client reload so all synced rows are flushed from memory (no stale data after logout).
- R4. The shell is a two-pane layout — a persistent session sidebar and a main session-detail pane — with a header showing the signed-in user and a logout control.

**Session list, search & navigation**
- R5. The sidebar lists only the authenticated user's sessions, each showing title, status, and last-activity time, with active/recent first.
- R6. A search/filter input narrows the session list by title; a status filter (e.g., running / interrupted / done) is available.
- R7. Selecting a session opens it in the detail pane, visibly marks it as current, and reflects it in the URL so a session is deep-linkable.
- R8. A "New session" control initiates session creation.

**Session creation**
- R9. Creating a session presents a task/prompt input (plus any minimal options) and, on submit, optimistically appears in the sidebar.
- R10. The new session opens in the detail pane and begins showing the agent's activity as the run starts.

**Session detail — live trace**
- R11. The detail pane streams the session's events live as an ordered vertical trace: assistant messages, thinking, tool calls, and tool results, appended in real time.
- R12. Each tool call renders as a card showing tool name, arguments, status (proposed / pending / running / cancelled / substituted / done), and its streaming result.
- R13. A session status indicator shows running / awaiting-approval / interrupted / completed / error.
- R14. The trace auto-follows the newest event while live, and lets the user scroll back without losing the ability to return to the live tail.

**Interception & forking controls**
- R15. A running read-only tool card exposes live controls: Cancel & swap (to another read-only tool), Edit args, and Cancel.
- R16. A side-effecting tool card in the pending/approval state exposes Approve, Swap (to a read-only tool), Edit args, and Reject, and does not execute until acted on (or auto-approved by policy).
- R17. "Swap" opens a picker listing only read-only tools as substitutes; choosing one substitutes the tool for that step.
- R18. "Edit args" opens an editable view of the tool's arguments; submitting runs the tool with the edited args.
- R19. After an override, the card shows the executed (substituted) tool and its result, and the original proposed tool remains visible as audit (e.g., "operator substituted grep → read").
- R20. Interception actions reflect live in the trace with no full-run restart and no visible re-planning step.

**Diffs**
- R21. File-writing tools render their proposed change as a diff (added/removed lines) inside the card; approval acts on exactly what the diff shows.
- R22. Non-file tool results render as text or structured output, not diffs.

**Session lifecycle controls**
- R27. Destructive actions (delete session) require confirmation before applying.
- R28. Interrupt and continue are operable from the session view, and the status indicator reflects the interrupted/resumed state.

**Real-time, multi-window & feedback**
- R23. All displayed collections (sessions, events, tool calls, messages) are projections of synced state; the UI holds no separate source of truth for domain data.
- R24. Two windows open on the same session reflect the same live updates and interception outcomes without manual refresh.
- R25. Create, rename, and delete apply optimistically and reconcile against synced truth (no flicker, no stale state).
- R26. Empty (no sessions yet), loading (connecting/syncing), and error (connection/sync lost, action failed) states are explicitly represented.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given a logged-out visitor, when they open the app, then they see only the sign-in entry and no session data; after logout, the client reloads and no previously-synced rows remain.
- AE2. **Covers R5, R6.** Given a user with several sessions, when they type in the search box, then the sidebar narrows to matching sessions live.
- AE3. **Covers R15, R17, R19, R20.** Given a running read-only `grep`, when the operator chooses "Cancel & swap → read", then `grep` stops, `read` runs, the card shows `read` as executed with `grep` retained as audit, and the trace continues with no restart.
- AE4. **Covers R16, R21.** Given the agent proposes `write_file`, when the card is in the approval state, then a diff of the change is shown and the file is not written until the operator approves.
- AE5. **Covers R24.** Given two windows on one session, when an operator approves a tool in window A, then window B reflects the approval and resulting events live.
- AE6. **Covers R25, R27.** Given a user deletes a session, when they confirm, then it disappears immediately and stays gone after sync reconciles.

---

## Success Criteria

- A first-time reviewer can sign in, find or create a session, watch the agent work live, and intercept a tool — without instructions.
- The interception headline is demonstrable in the UI: swap a running read-only tool, and approve/amend a file write (with diff), live, in two windows.
- Every PRD-required UI capability is present: login/logout, list & navigate sessions, create/delete, interrupt/continue, rename, and live viewing.
- ce-plan can build the UI without inventing screens, controls, states, or data flows.

---

## Scope Boundaries

- No workspace or file-tree browser — diffs come from file-write events only, not a file explorer.
- No divergent-branch UI and no replay/time-travel scrubber — live interception is the headline; replay is deferred.
- Auth UI limited to WorkOS AuthKit login/logout — no signup, profile, settings, or in-app user-management screens.
- Search is over the session list; full-text in-session event search is out of scope (optional later).
- No multi-user collaboration, sharing, or presence UI.
- No mobile-optimized layout beyond basic usability.

---

## Key Decisions

- Hybrid paradigm: a live trace as the spine, PR-review-style panel (with diffs) only at the interception moment — keeps the agent's autonomy and uses the PR/diff metaphor only where it adds value.
- WorkOS AuthKit hosted login as the auth UX: minimal surface, offloads the login screen, and provides the authenticated identity that scopes each user's Electric shapes (per-user sync isolation).
- Two-pane shell with deep-linkable sessions: matches the PRD's "list and navigate" requirement and makes the two-window demo natural.
- UI is a pure projection of synced state with optimistic writes: directly serves provable real-time sync and the no-flicker two-window proof.
- Logout forces a client reload to flush synced rows: closes the stale-cross-user-data leak that Electric's caching can otherwise cause.

---

## Dependencies / Assumptions

- Depends on the interception/event-log backend (`docs/brainstorms/2026-06-02-live-tool-interception-requirements.md`) for the tool-call states, override semantics, and audit data the UI renders.
- Depends on WorkOS AuthKit being configured; the per-user Electric shape scoping uses the WorkOS-authenticated identity.
- Assumes the tool policy classification (read-only vs side-effecting) is available to the client so it can show the correct control set per card.
- Assumes file-write diffs are derivable from synced events (proposed content vs current file state).
- The visual design is fixed by the hi-fi handoff, extracted to `design-reference/DESIGN-SYSTEM.md` (tokens, type, spacing, status colors, component specs, icons, motion). The implementation matches that spec; the handoff's HTML/JS/CSS and mock data are reference only and do not ship.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R16][Technical] Whether side-effecting tools auto-approve after a timeout or require explicit approval each time — the card's pending behavior must reflect whichever policy is chosen.
- [Affects R21][Technical][Needs research] Diff source for file writes — does the agent emit before/after content, or does the client compute the diff from a synced file snapshot?
- [Affects R14][Design] Exact auto-follow vs scroll-lock interaction for long live traces.
