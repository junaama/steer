---
date: 2026-06-05
topic: live-agent-experience-overhaul
---

# Live Agent Experience Overhaul

## Summary

Replace Steer's one-tool-per-cold-generation loop with a streaming, multi-tool, reasoning-preserving agentic loop, and render that stream as a legible live transcript (markdown, syntax-highlighted code, a diff you review before each edit applies). Add four steerability capabilities — an `ask_user` clarify primitive, git working-set diff awareness, write-side LSP, and image/vision input — all while preserving Steer's per-tool approval gate. Built on proven open-source agent patterns and rendering libraries, not rebuilt from scratch.

---

## Problem Frame

Watching a Steer session does not feel like watching a live coding agent, and the cause is the loop architecture, not the instructions or the tool set (which are both adequate). In `apps/agent/src/model.ts` the loop calls `generateText({ maxSteps: 1 })`, takes only `result.toolCalls[0]`, and rebuilds context from the event log on every step; `decide.ts` discards the model's text whenever a tool call is present. Concretely, an operator sees four failures, all confirmed in practice:

- **Slow & plodding** — one tool call per full cold generation, never in parallel, with a model round-trip and context rebuild before every action.
- **Silent** — the model's reasoning is thrown away when it accompanies a tool call, and nothing streams (`generateText`, not `streamText`), so tool calls appear with no visible "why."
- **Gives up early** — a single no-tool reply ends the turn; nothing drives the agent through plan→act→verify, so it declares done or asks the operator to go check.
- **Doesn't verify** — verification is only suggested in the system prompt, never enforced by the loop, so edits land unchecked.

The result reads as a black box that plods, stays quiet, bails, and leaves unverified changes — the opposite of the "watch a coding agent work, and steer it live" promise the product is built around. Modern open-source agents (Claude Code's streaming transcript, Cline's plan/diff-review gates) have solved exactly this; the gap is that Steer hasn't adopted those patterns.

---

## Actors

- A1. Operator — the human running/watching a session; reads the live transcript, approves or rejects tool calls and edit diffs, answers the agent's clarifying questions, interrupts and continues.
- A2. Agent loop — the headless daemon turn loop that drives the model, streams reasoning/tool calls, executes approved tools, and verifies its own work.
- A3. Reviewer — the take-home evaluator who must experience the above as a credible live coding agent during the demo with no host configuration.

---

## Key Flows

- F1. Live, steerable task turn
  - **Trigger:** Operator sends a task (optionally with an image) to a session.
  - **Actors:** A1, A2
  - **Steps:** Agent streams reasoning token-by-token → requests one or more tools → read-only tools run immediately; each side-effecting tool pauses at the approval gate (edits shown as a reviewable diff) → operator approves/rejects (or the agent calls `ask_user` and waits) → approved tools execute, results stream back → after a file mutation the agent runs tests/build and iterates on failures → agent finishes with a summary naming the files/identifiers touched.
  - **Outcome:** A completed, verified change the operator watched unfold and steered, with the full transcript persisted and synced.
  - **Covered by:** R1, R2, R3, R5, R6, R9, R11, R15, R16

The loop/gate shape (the one invariant: every side-effecting tool still stops at the gate):

```
model turn ──stream reasoning + tool calls──▶ [read-only tool] ─run─▶ result ─┐
                                            └▶ [side-effecting] ─▶ APPROVAL ─▶ run ─▶ result ─┤
                                                                   (diff review / ask_user)        │
        ◀─────────────────── stream results back; continue same turn ─────────────────────────────┘
                          └─ after an edit: run tests/build, iterate until green ─┘
```

---

## Requirements

**Agent loop behavior (fixes the four failures)**
- R1. The agent's text and reasoning stream to the UI token-by-token as produced, rather than appearing in batches on step completion.
- R2. When the model emits reasoning/preamble text alongside a tool call, that text is retained and shown — the operator can always see why a tool is being called (today it is discarded).
- R3. The loop executes multiple tool calls from a single model turn when the model requests them (independent reads/searches run together), instead of taking only the first.
- R4. Within a turn, the assistant's interleaved reasoning, tool calls, and results form one continuous thread the model builds on, instead of a cold re-generation per tool call.
- R5. The loop drives the agent through plan→act→verify and does not end the task on the first no-tool reply while the original request is unmet; "done, please verify it yourself" completions are eliminated.
- R6. After any file mutation, the agent runs the project's tests/build and iterates on failures before declaring the task complete.

**Live transcript rendering**
- R7. Assistant and user messages render as markdown (headings, lists, emphasis, inline code, links), not plain text.
- R8. Fenced code blocks and file contents render with language-aware syntax highlighting.
- R9. Every file edit is presented as a reviewable, syntax-highlighted diff (added/removed lines) that the operator approves or rejects before it applies.
- R10. Tool cards appear immediately with their reasoning and stream their output as it arrives; long transcripts stay responsive (virtualized rendering).

**New steerability capabilities**
- R11. An `ask_user` clarify tool lets the agent pause, surface one targeted question in the UI, and wait for the operator's answer before continuing — instead of guessing or giving up.
- R12. A git working-set diff tool reports the current working-tree diff, so the agent and UI can show "what has changed so far" without reconstructing it from individual edit calls.
- R13. The read-only LSP gains write-side actions: `rename_symbol`, `format`, and `code_action`.
- R14. The operator can attach an image (screenshot, error, design mock) to a task/message, and the agent can read it when the provider/model supports vision; non-vision providers degrade gracefully.

**Steering & persistence (invariants)**
- R15. Every side-effecting tool — including the new ones — still routes through the per-tool approval gate; streaming/parallel execution pauses for approval and resumes, so the operator can intercept mid-run.
- R16. Streamed reasoning deltas and attached images are persisted and Electric-synced as first-class events, so both the live UI and a mid-stream page reload reconstruct the full transcript.

---

## Acceptance Examples

- AE1. **Covers R2.** Given the model emits "Let me check the config" immediately before a `grep` call, when the step renders, the operator sees both the reasoning line and the grep card — the text is not dropped.
- AE2. **Covers R9, R15.** Given the agent proposes an `edit_file`, when it reaches the gate, the UI shows a reviewable diff and the file does not change until the operator approves.
- AE3. **Covers R5, R6.** Given "fix the failing test," when the agent edits and the test still fails, it re-runs and re-edits until it passes rather than replying that it is done.
- AE4. **Covers R11.** Given the agent is missing a required detail it cannot safely assume (e.g., which of two matching files), when it cannot proceed, it calls `ask_user` and waits for the operator's answer instead of guessing.
- AE5. **Covers R3.** Given the model requests three independent file reads in one turn, when the loop runs, all three execute rather than only the first.
- AE6. **Covers R1, R16.** Given a running session producing a long reasoning block, when the operator watches, the text streams token-by-token; reloading the page mid-stream reconstructs what has arrived so far from synced events.

---

## Success Criteria

- Watching a Steer session feels like watching a competent agent work live: reasoning streams, several actions happen without long stalls, edits are reviewed as diffs, the agent verifies its own work, and it asks when genuinely unsure. The four observed failures are visibly gone in the demo a reviewer runs from `docker compose up`.
- ce-plan can implement without inventing product behavior: the loop contract (stream, preserve reasoning, multi-tool, plan→act→verify), the rendering surface, the four new tools, the interception-preserved invariant, and the event-model implication for reasoning/images are all specified here.

---

## Scope Boundaries

- The full multi-pane workbench (live changed-files panel + separate verify/terminal pane) — the noted fast-follow, designed on top of R12, not this round.
- Checkpoint / revert (snapshot before a batch and roll back the agent) — deferred candidate.
- Semantic `search_code` (pgvector embeddings) — deferred; grep/glob remain the search path. A separate plan (`docs/plans/2026-06-03-003-feat-native-semantic-code-search-plan.md`) exists if it is ever wanted.
- Agent abilities beyond the four agreed (`ask_user`, git-diff, write-side LSP, vision): no `apply_patch` edit-format change, no structured `run_tests` tool, no notebook/file-move tools — `multi_edit`, `run_command`, and `bash` already cover these.
- No changes to auth, the sync transport, or infra; no new banned dependencies (no Next.js, websockets, non-postgres DB, or coding-agent SDK).

---

## Key Decisions

- Anchor on a streaming live transcript (approach A) plus diff-review approvals (approach B); defer the workbench (approach C). Rationale: A fixes the behavior and is the substrate both B and C need; B turns Steer's generic approve/deny into a genuinely useful diff review — the point of an interceptable agent.
- Speed stays subordinate to steerability: the streaming/parallel loop still gates every side-effecting tool. Rationale: per-tool interception is Steer's identity and a PRD requirement; we do not trade it for raw throughput.
- Build on open-source agent patterns and rendering libraries (Vercel AI SDK streaming multi-step tool loop; markdown/syntax-highlight/diff libraries), not hand-rolled equivalents. Rationale: explicit user directive to adopt proven theories; the PRD allows the Vercel AI SDK and ordinary rendering libraries — only coding-agent SDKs are banned.
- `ask_user` and git-diff are in-scope prerequisites, not optional extras. Rationale: both are load-bearing for the live, steerable experience (clarify attacks "gives up early"; git-diff powers the diff gates and the future changed-files panel).

---

## Dependencies / Assumptions

- The Vercel AI SDK's streaming, multi-step tool loop (`streamText`) is the loop engine. Verified PRD-allowed: `apps/CLAUDE.md`/PRD explicitly permits the Vercel AI SDK and bans only coding-agent SDKs.
- The configured provider/model supports streaming and parallel tool calls; vision (R14) requires a vision-capable model, and non-vision providers degrade gracefully (image input simply unavailable). Assumption — provider capability detection is a planning concern.
- Rendering libraries (markdown, syntax highlighting, diff view) will be added to `apps/web`. These are rendering libraries, not coding-agent SDKs, so they are PRD-compliant; exact library choices are ce-plan's call.
- The per-tool approval gate (`apps/agent/src/intercept.ts`) and the Electric event-sync allowlist (`apps/server/src/proxy.ts`) are preserved; new event content types extend the existing event log rather than replacing it. Verified against current code.
- Take-home constraints hold: `docker compose up` with only a `.env`, no host configuration, 100% TypeScript, agent container stays portless/outbound-only. Verified PRD.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R6][User decision] Verify-after-edit: should the loop **structurally require** a test/build step after an edit (safer, but can feel rigid and slow on tasks with no tests), or **strongly steer** the model to verify (lighter, less guaranteed)? This shapes how R6 is enforced.

### Deferred to Planning

- [Affects R16][Technical] The exact event-model/schema for streamed reasoning deltas and images: new event types, how token deltas coalesce into a message on reload, and how images are stored and synced within the no-websockets + Electric constraint.
- [Affects R1, R15][Technical] How mid-stream approval pauses interleave with token streaming — pausing the stream at a tool boundary, queuing the side-effecting call, and resuming — without breaking the live feel.
- [Affects R10][Technical] Transcript virtualization approach and library choice.
- [Affects R7, R8, R9][Technical] Specific rendering libraries (markdown, syntax highlighter, diff view) and safe-rendering/sanitization strategy.
- [Affects R14][Needs research] Provider/model vision-capability detection and the image-ingestion path into a portless, outbound-only agent container.
