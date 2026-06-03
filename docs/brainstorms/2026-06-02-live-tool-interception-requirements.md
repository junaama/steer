---
date: 2026-06-02
topic: live-tool-interception
---

# Live Tool Interception (Execution Forking)

## Summary

While a coding-agent run is in flight, an operator can intercept the tool the agent chose — substituting it for another read-only tool (`grep`→`read`, `ls`→`web_fetch`) and/or editing its arguments — and the run continues seamlessly with no extra inference. Read-only tools are cancellable mid-execution; side-effecting tools are gated behind approval. This rides the existing event log and sync control path, and is the submission's headline differentiator on top of the required spec.

---

## Problem Frame

A reviewer watching a headless coding agent can see it work, but can only *stop* it (interrupt) or *let it finish* — the required, table-stakes controls. When the agent picks a wasteful or wrong tool — a broad `grep` where a targeted `read` would do, a `web_fetch` of the wrong URL — the operator's only recourse today is to let the bad call burn time and tokens, then interrupt and restart, or wait it out. Both are slow and both throw away the run's accumulated, cache-warm context.

The conventional fix (the kind described in HumanLayer's own "context forking" writeup) is to *rewind* to an earlier user-turn boundary by popping messages — which invalidates the prompt cache and risks mangling accumulated state, and explicitly avoids reaching into a live tool sequence. The pain that motivates this work is finer-grained: the operator wants to correct the *next action* in place, while the run keeps moving, without paying the cost of a restart or a re-plan.

---

## Actors

- A1. Operator — the human in the UI watching a live run; intercepts a proposed/running tool call to substitute the tool and/or edit its args.
- A2. Agent daemon — the headless run executing the agent loop; proposes and executes tools, observes synced control signals, emits events. Portless, outbound-only.
- A3. Server / write boundary — validates and persists control rows and events (the only write path); the source Electric syncs from.

---

## Key Flows

- F1. Swap a read-only tool mid-execution (headline)
  - **Trigger:** Agent starts a read-only tool (e.g., `grep`) the operator judges wrong/wasteful.
  - **Actors:** A1, A2, A3
  - **Steps:** Operator sees the executing tool live → writes a substitution (new tool and/or edited args) through the normal write path → the override syncs to the agent → the agent cancels the in-flight read-only tool, discards partial output, runs the substitute → the substitute's result becomes the step result.
  - **Outcome:** The run continues into its normal next turn carrying the substituted result; no restart, no re-plan; the original proposed tool is retained in the audit log.
  - **Covered by:** R2, R5, R6, R7, R8, R9, R10, R11, R13

- F2. Approval gate for a side-effecting tool
  - **Trigger:** Agent proposes a side-effecting tool (e.g., `write_file`).
  - **Actors:** A1, A2, A3
  - **Steps:** Tool enters a pending state synced to the UI → operator approves, edits args then approves, or substitutes a read-only tool → only then does execution proceed.
  - **Outcome:** No side-effecting tool runs without passing the interception window; the operator has a guaranteed chance to redirect.
  - **Covered by:** R3, R5, R6, R13

---

## Requirements

**Interception model & policy**
- R1. Each tool is classified by policy as read-only (swap-eligible, cancellable mid-execution) or side-effecting (must pass an approval gate before executing).
- R2. Read-only tools execute immediately but run under a cancellable wrapper that observes operator control signals; the operator may cancel an in-flight read-only tool.
- R3. Side-effecting tools enter a pending state and do not execute until approved (or auto-approved by policy), giving the operator a guaranteed interception window.
- R4. A proposal-gate interception path (approach A) covers all tools as the guaranteed floor; live mid-execution cancel-and-substitute (approach B) is enabled for at least one read-only tool to land the headline demo.

**Tool substitution & arg editing**
- R5. When intercepting, the operator may substitute the tool, edit the chosen tool's arguments, or both.
- R6. A substitute (replacement) tool must be read-only; the swap-eligible universe is read-only tools only.
- R7. The substituted/edited tool executes with operator-supplied or translated args, and its result becomes the result of that step.

**Loop continuity & context projection**
- R8. Substituting or editing a tool must not trigger an extra re-planning inference; the agent's normal next turn consumes the substituted result.
- R9. The agent's LLM context is reconstructed from persisted state as a projection in which the executed (substituted) tool call appears as the call, preserving coherence and the prompt-cache prefix.
- R10. A cancelled read-only tool discards partial output; no partial result is persisted as the step result.

**Audit & sync**
- R11. The event log immutably records the original proposed tool, the operator override (substitution and/or arg-edit), and the executed tool plus result.
- R12. Interception is driven through the existing synced control path (control row → agent), not a new channel or websocket; the agent container stays portless/outbound-only.
- R13. Proposed, pending, executing, cancelled, and substituted states sync to the UI live so the operator can see and act on them in real time, including across multiple windows.

**Scope guard**
- R14. All PRD-required capabilities remain fully intact and unmodified: the auth/authorization boundary, all collections synced via Electric + TanStack DB, a clean `docker compose up`, and interrupt + continue sessions. Tool interception is strictly additive.

---

## Acceptance Examples

- AE1. **Covers R2, R5, R7, R8, R9, R10.** Given the agent has started a read-only `grep`, when the operator substitutes `read` with adjusted args, then `grep` is cancelled and its partial output discarded, `read` runs, its output becomes the step result, and the agent's next turn proceeds with no extra re-planning inference.
- AE2. **Covers R3.** Given the agent proposes a side-effecting `write_file`, when no approval is given, then the tool does not execute and the run waits at the proposal gate.
- AE3. **Covers R5, R7.** Given the agent proposes `web_fetch` with the wrong URL, when the operator edits the args (same tool, corrected URL), then `web_fetch` runs with the corrected URL.
- AE4. **Covers R11, R13.** Given an operator substitutes a tool, when a second browser window is open on the same session, then both windows show the proposed → overridden → executed sequence live, and the event log retains the original proposed tool for audit.
- AE5. **Covers R6.** Given the operator opens the substitute picker, when choosing a replacement tool, then only read-only tools are offered.

---

## Success Criteria

- In the demo, an operator visibly redirects a live run by swapping a tool; the agent continues without restarting or re-planning, and the time/token saving is obvious.
- The swap is provably real-time (two-window) and audited (the original proposed tool is retained in the log).
- ce-plan can implement without inventing product behavior: policy classification, interception timing, substitution/arg-edit rules, continuity semantics, and the floor/reach split are all specified here.
- Every PRD-required capability still passes after this feature is added (the scope guard holds).

---

## Scope Boundaries

- Divergent persisted parallel branches (true A/B forking, multiple live timelines from one checkpoint) — deferred; the event log keeps the door open.
- Mid-execution cancellation or rollback of side-effecting tools — out of scope; they go through the approval gate instead.
- Message-popping / rewind-to-an-earlier-user-turn (the blog's context-forking shape) — out for v1; the event log enables it later.
- Branch merge/conflict resolution and per-branch workspace sandboxing — out (no parallel branches in v1).
- Substituting *to* a side-effecting tool — out; the replacement universe is read-only.
- Automatic/policy-driven swap suggestions — out; interception is operator-driven only.

---

## Key Decisions

- Hybrid interception (live-cancel read-only + approval-gate side-effecting): literal mid-execution where it's safe, a safety gate where it isn't.
- Floor-first delivery (proposal-gate A guaranteed for all tools; live-cancel B for at least one read-only tool): protects the required deliverables — A alone is a complete, reliable demo.
- Context as a projection of the event log, not a rewrite of raw history: this is what makes "swap with no extra inference" real and keeps the prompt-cache prefix intact (a tool swap is a cache hit; the rewind alternative is a cache miss).
- Override via the existing control-plane-via-data-plane: no new transport, reuses sync, honors the no-websocket constraint and the portless agent container.
- Read-only-only swap universe: contains the hard cancellation/rollback problem to side-effect-free tools, which matches the operator's real use cases (`grep`/`read`/`ls`/`web_fetch`).

---

## Dependencies / Assumptions

- Layered on the append-only event log and the event-projection/crash-only agent loop (ideation #1 and #7); interception is an extension of that substrate, not a parallel system.
- Assumes the agent loop is built on a runtime that owns tool execution with lifecycle hooks / cancellation (e.g., Vercel AI SDK tool hooks + an AbortSignal), not a pre-built coding-agent SDK (PRD constraint).
- Assumes at least one read-only tool is slow enough to demonstrate true mid-execution cancellation reliably in the Loom.
- Assumes prompt caching is in use, so the prefix-preservation benefit is real (provider-dependent).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2, R10][Technical][Needs research] Exact cancellation mechanics for in-flight read-only tools (AbortSignal vs child-process kill) and how partial output is discarded, per tool.
- [Affects R9][Technical] Whether the projected context includes a brief inline system note when a substitution occurs (to help the model adapt to an unexpected result shape) — default assumption is yes; validate against model behavior.
- [Affects R3][Technical] For side-effecting tools, whether approval is required every time or can be auto-approved by a per-tool policy/timeout.
