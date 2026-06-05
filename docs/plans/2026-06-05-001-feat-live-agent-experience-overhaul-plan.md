---
date: 2026-06-05
status: active
type: feat
origin: docs/brainstorms/2026-06-05-live-agent-experience-overhaul-requirements.md
---

# feat: Live Agent Experience Overhaul

## Summary

Rebuild Steer's turn loop into a streaming, multi-tool, reasoning-preserving agentic loop (Vercel AI SDK v4 `streamText` / `fullStream`), render that stream as a legible live transcript (markdown, syntax-highlighted code, reviewable edit diffs), and add four steerability capabilities (`ask_user`, `git_diff`, write-side LSP, vision input) — all while preserving Steer's per-tool `controls` approval gate and the Electric event-sync model.

Origin requirements: `docs/brainstorms/2026-06-05-live-agent-experience-overhaul-requirements.md`.

---

## Problem Frame

Watching a Steer session does not feel like a live coding agent, and the cause is the loop architecture, not the prompt or the tool set. In `apps/agent/src/model.ts` the driver calls `generateText({ maxSteps: 1 })`, keeps only `result.toolCalls[0]`, and `apps/agent/src/decide.ts` discards the model's text whenever a tool call is present; `apps/agent/src/loop.ts` processes exactly one `Step` per iteration. The observable result is four failures the operator confirmed: **slow & plodding** (one tool per cold generation, never parallel), **silent** (reasoning discarded, nothing streams), **gives up early** (a single no-tool reply ends the turn), and **doesn't verify** (verification only suggested). The product's promise — "watch a coding agent work, and steer it live" — is undercut at its core. Modern open-source agents (Claude Code's streaming transcript, Cline's plan/diff-review) have solved this; Steer simply hasn't adopted the patterns.

---

## High-Level Technical Design

The loop changes from "one `Step` per model round-trip" to "one streamed assistant turn that yields deltas + a batch of tool calls, each tool still gated." Directional only — illustrates the intended shape, not implementation specification; the implementing agent should treat it as context, not code to reproduce.

```
runSession turn:
  streamText(messages, tools WITHOUT execute)  ──▶ fullStream parts:
     ├─ 'reasoning'   → buffer → emit thinking_delta rows (coarse chunks)
     ├─ 'text-delta'  → buffer → emit message_delta rows (coarse chunks)
     └─ 'tool-call'   → collect into this turn's tool batch
  on finish:
     ├─ coalesce buffered deltas → terminal thinking / message event(s)   (reasoning PRESERVED, R2)
     └─ for each tool call in batch (R3):
            emit tool_proposed
            read-only      → execute (reads may run together)            ┐ existing
            side-effecting → status=awaiting-approval → poll controls ───┤ intercept gate
                             (approve / reject / override)                ┘ UNCHANGED (R15)
            emit tool_result   (stream long stdout via tool_stdout_delta)
  loop until the model finishes a turn with no tool calls and the task is met (R5)
```

Streaming transport: no websockets (PRD). Deltas are ordinary `events` rows synced by Electric; "streaming" = coarse delta-rows (buffer-flush granularity), not per-token, to keep the event log bounded. The covered loop is tested with a **fake streaming driver** (the streaming successor to today's `ScriptedModel`); the real `streamText` wiring stays in coverage-excluded `model.ts`, verified by the capstone e2e + demo.

---

## Requirements Traceability

| Origin requirement | Units |
|---|---|
| R1 stream text/reasoning live | U1, U2, U3, U4 |
| R2 preserve reasoning beside tool calls | U2, U3 |
| R3 multiple tool calls per turn | U2, U3 |
| R4 persistent turn thread | U2, U3 |
| R5 don't give up early | U2, U3 |
| R6 verify-after-edit (prompt-steered) | U2 |
| R7 markdown rendering | U5 |
| R8 syntax-highlighted code | U5 |
| R9 diff-review approvals | U6 |
| R10 live tool cards + virtualization | U4 |
| R11 `ask_user` clarify tool | U7 |
| R12 git working-set diff tool | U8 |
| R13 write-side LSP | U9 |
| R14 vision input | U10 |
| R15 interception preserved | U3, U6, U7, U9 |
| R16 reasoning/images as synced events | U1, U4, U10 |
| F1 live steerable turn; AE1–AE6 | U3 (AE1, AE3, AE5), U6 (AE2), U7 (AE4), U11 (AE1–AE6 capstone) |

Actors (origin): A1 Operator, A2 Agent loop, A3 Reviewer — preserved by the interception gate (A1), the loop rebuild (A2), and the `docker compose up` demo path (A3, U11).

---

## Implementation Units

### Phase A — Streaming loop foundation

### U1. Streaming delta event types

**Goal:** Add first-class event types for the agent's streamed assistant text and reasoning so the loop can persist deltas and the UI can render them live.
**Requirements:** R1, R2, R16
**Dependencies:** none
**Files:**
- `packages/schema/src/schema.ts` (extend `EVENT_TYPES`)
- `packages/schema/src/zod.ts` (per-type payload schemas)
- `packages/schema/src/zod.test.ts` (or the existing schema test file)
- `apps/server/drizzle/` (new migration **only if** `events.type` has a DB-level CHECK/enum constraint — verify first; the column is `text`, so likely no migration)
- `apps/agent/src/store.test.ts`
**Approach:** Add `message_delta` and `thinking_delta` event types, payload `{ text: string, parentToolCallId?: string }` (mirror existing `message`/`thinking`). Reuse the already-defined-but-unused `tool_stdout_delta` for streamed tool output. Deltas are **non-terminal** — they must not count toward `completedSteps()` in `apps/agent/src/loop.ts` (which counts only terminal events). Confirm `events` is already in the `proxy.ts` `COLLECTIONS` allowlist (it is) — no proxy change; new rows sync automatically.
**Patterns to follow:** existing `message`/`thinking` schema + zod entries; `tool_stdout_delta`'s existing (unused) definition.
**Test scenarios:**
- `appendEvent` accepts a `message_delta` with valid payload and rejects one missing `text` (zod).
- `appendEvent` accepts a `thinking_delta`; seq increments atomically alongside other events.
- `completedSteps()` is unchanged by delta events (a session with only deltas + one terminal message counts as one step). Covers the non-terminal invariant.
**Verification:** new types validate via zod, persist with correct seq ordering, and are ignored by the step cursor.

### U2. Streaming model driver

**Goal:** Replace the single-shot driver with a streaming one that emits reasoning/text deltas as they arrive and returns the turn's full batch of tool calls for the loop to execute.
**Requirements:** R1, R2, R3, R4, R5, R6
**Dependencies:** U1
**Files:**
- `apps/agent/src/model.ts` (coverage-excluded boundary)
- `apps/agent/src/loop.ts` (the `ModelDriver` interface/contract only)
**Approach:** Rebuild `createModelDriver` to call `streamText` with tools declared **without** an `execute` fn (so the SDK returns tool calls instead of running them — confirmed AI SDK v4 behavior). Consume `result.fullStream`, routing parts: `reasoning` → `onThinkingDelta`, `text-delta` → `onTextDelta` (both coarsely buffered by the caller), `tool-call` → collected into a returned batch. Change the `ModelDriver` contract from `next(): Step` to a streaming turn: a delta callback set plus a return of `{ text, reasoning, toolCalls: ToolCall[] }` for the turn. Strengthen the system prompt for **plan→act→verify** and **don't-give-up** (R5) and **verify-after-edit via prompt** (R6, per the chosen "steer via prompt only" policy) — no structural enforcement. Keep `createSubagentDriver` on the same contract.
**Execution note:** define the new `ModelDriver` contract first so U3 can be built and tested against a fake implementing it.
**Patterns to follow:** current `model.ts` provider resolution (`resolveProvider`/`resolveModelId`) and `telemetry()`; the existing tools-declared-not-executed stance.
**Technical design (directional, not spec):** `for await (const part of result.fullStream) switch(part.type){ 'reasoning'|'text-delta'|'tool-call' ... }` then return the collected batch on `finish`.
**Test scenarios:** `Test expectation: none — model.ts is coverage-excluded (external SDK boundary).` The contract is exercised by U3's fake driver and U11's capstone.
**Verification:** the agent suite type-checks against the new `ModelDriver` contract; a live session streams reasoning and can emit multiple tool calls in one turn.

### U3. Loop rebuild — multi-tool, reasoning-preserving, streaming

**Goal:** Rewrite the turn loop to consume streamed deltas, keep the model's reasoning even when it accompanies tool calls, execute multiple tool calls per turn through the existing gate, and drive the agent through the task without giving up early.
**Requirements:** R2, R3, R4, R5, R15, R16; F1; AE1, AE3, AE5
**Dependencies:** U1, U2
**Files:**
- `apps/agent/src/loop.ts`
- `apps/agent/src/decide.ts`
- `apps/agent/src/context.ts`
- `apps/agent/src/loop.test.ts`
- `apps/agent/src/decide.test.ts`
- `apps/agent/src/context.test.ts`
**Approach:** `runSession` drives one streamed turn at a time: wire the driver's delta callbacks to buffer text/reasoning and flush coarse `message_delta`/`thinking_delta` rows, then on turn finish coalesce buffers into terminal `thinking`/`message` events (reasoning is **kept** even when tool calls follow — fixes the `decide.ts` discard, R2). Execute the turn's tool-call batch sequentially through `resolveTool` so each side-effecting call still hits the `controls` gate (R15); read-only calls in a batch may run together. Replace `decideStep`'s "tool call wins, text discarded" with "emit reasoning/text **and** process the tool batch." Completion (R5): a turn that finishes with no tool calls ends the turn; the safety ceiling (`maxSteps`) and the no-progress guard stay. Update `context.ts` so the rebuilt assistant turn (reasoning + tool calls + results) projects into the LLM thread coherently.
**Patterns to follow:** existing `runSession` structure (interrupt check, `completedSteps` cursor, `parentEvents`, no-progress guard, plan reconciliation); `intercept.ts` `resolveTool` is reused **unchanged**.
**Test scenarios (DB-backed, fake streaming driver):**
- Covers AE5. A turn whose fake driver yields three read-only tool calls executes all three (not just the first); three `tool_result` events persist.
- Covers AE1. A turn yielding reasoning text + a tool call persists both a `thinking`/`message` event and `tool_proposed` — the reasoning is not dropped.
- Covers AE3. A scripted edit→failing run→edit→passing run sequence drives multiple turns and ends `completed` (no premature stop while the task is unmet).
- A side-effecting tool in a multi-call batch sets status `awaiting-approval` and waits for an `approve` control before `tool_result` (gate preserved).
- Streamed `message_delta` rows are emitted then coalesced; the final `message` text equals the concatenated deltas.
- The `maxSteps` ceiling and no-progress guard still terminate runaway/looping turns.
**Verification:** the full agent suite passes at the enforced coverage (lines/fns/stmts 100, branches ≥90); a session preserves reasoning, runs multiple tools per turn, and only completes when the task is met.

### Phase B — Live transcript rendering

### U4. Stream deltas into the live trace + virtualize

**Goal:** Render streamed reasoning/text/tool-output as it arrives and keep long transcripts responsive.
**Requirements:** R1, R10, R16
**Dependencies:** U1, U3
**Files:**
- `apps/web/src/lib/trace.ts`
- `apps/web/src/lib/trace.test.ts`
- `apps/web/src/components/SessionDetail.tsx`
- `apps/web/src/components/ToolCard.tsx`
- `apps/web/src/components/SessionDetail.test.tsx`
- `apps/web/package.json` (virtualization dep, e.g. a list virtualizer)
**Approach:** Extend `buildTrace` to fold `message_delta`/`thinking_delta` into the growing message/thinking item and `tool_stdout_delta` into a streaming tool-output buffer on the `ToolItem`, so the existing Electric subscription re-renders incrementally as delta rows sync. Add list virtualization to the trace container for long sessions. Keep the terminal-event rendering intact (a coalesced `message` replaces its deltas).
**Patterns to follow:** `buildTrace`/`buildTraceLevel` tool-folding by `toolCallId`; the existing `live-tail` indicator.
**Test scenarios:**
- `buildTrace` with `[message_delta('Hel'), message_delta('lo')]` yields one message item reading "Hello".
- A `tool_proposed` + two `tool_stdout_delta` chunks render a tool card whose output is the concatenated chunks before `tool_result` arrives.
- When a terminal `message` follows its deltas, the item renders once (no duplicate).
- A trace with many items mounts without rendering all rows (virtualization) — assert windowing behavior.
**Verification:** web suite passes at coverage gate; a running session visibly streams text and tool output; a long trace stays responsive.

### U5. Markdown + syntax-highlighted code rendering

**Goal:** Render assistant/user messages as markdown and code blocks with language-aware highlighting.
**Requirements:** R7, R8
**Dependencies:** U4
**Files:**
- `apps/web/src/components/Markdown.tsx` (new)
- `apps/web/src/components/Markdown.test.tsx` (new)
- `apps/web/src/components/SessionDetail.tsx` (use it for `ev-body`)
- `apps/web/package.json` (markdown renderer + syntax highlighter, e.g. react-markdown + Shiki/highlight.js)
**Approach:** Wrap message bodies in a `Markdown` component using a battle-tested renderer with safe defaults (no raw HTML injection) and a syntax highlighter for fenced code. Keep `thinking` styling distinct. Highlighting must work with the live-streaming partial markdown from U4 (render incrementally; tolerate unterminated code fences mid-stream).
**Patterns to follow:** existing `ev-message`/`ev-thinking` classes in `apps/web/src/styles.css`.
**Test scenarios:**
- A message with `**bold**`, a list, and a fenced ```ts code block renders the corresponding elements (not literal markup).
- A fenced block tagged `ts` gets language-highlighted markup; an untagged block still renders as a code block.
- Raw HTML in message text is not rendered as live HTML (sanitization/no-dangerous-html).
- A partial mid-stream message with an unterminated code fence renders without throwing.
**Verification:** web suite passes; messages and code read like a modern chat UI; no XSS via message content.

### U6. Diff-review approval gate

**Goal:** Present every file edit as a reviewable, syntax-highlighted diff that the operator approves or rejects before it applies.
**Requirements:** R9, R15; AE2
**Dependencies:** U5
**Files:**
- `apps/web/src/components/DiffView.tsx`
- `apps/web/src/components/DiffView.test.tsx`
- `apps/web/src/components/ToolCard.tsx`
- `apps/web/src/components/InterceptControls.tsx`
- `apps/web/src/components/InterceptControls.test.tsx`
- `apps/web/src/lib/diff.ts` (extend if needed)
**Approach:** For a `tool_proposed` carrying `before`/`after` (file-mutating tools already emit these per the event map), render a syntax-highlighted line-level diff in the `ToolCard`, and wire the existing approve/reject controls so the operator acts on the diff itself. This upgrades today's generic approve/deny into diff-review without touching the agent-side gate — the `controls` `approve`/`reject` flow (R15) is unchanged; only the operator's view of the proposal changes.
**Patterns to follow:** existing `lib/diff.ts` + `DiffView`; `InterceptControls` approve/reject wiring to `sendControl`.
**Test scenarios:**
- Covers AE2. A file-edit `tool_proposed` with before/after renders added/removed lines; the file is not shown as applied until an `approve` is sent.
- Approve sends an `approve` control for the proposal's `toolCallId`; reject sends a `reject`.
- A multi-hunk diff renders all hunks; an empty/no-op diff renders gracefully.
- Syntax highlighting applies to diff lines by file language.
**Verification:** web suite passes; edits are reviewed as diffs and only apply on approval.

### Phase C — New steerability capabilities

### U7. `ask_user` clarify tool

**Goal:** Let the agent pause, ask the operator one targeted question, and wait for the answer instead of guessing or giving up.
**Requirements:** R11, R15; AE4
**Dependencies:** U3
**Files:**
- `packages/schema/src/tools.ts` (register `ask_user`, policy)
- `packages/schema/src/schema.ts` + `zod.ts` (a question event/payload, or reuse `message` + a status; choose in implementation)
- `apps/agent/src/tools/index.ts` (or wherever the tool dispatch lives) + the tool impl
- `apps/agent/src/loop.ts` / `apps/agent/src/intercept.ts` (wait for the operator's answer)
- `apps/web/src/components/SessionDetail.tsx` (surface the question + an answer affordance)
- agent + web test files alongside
**Approach:** Register `ask_user` (args `{ question: string }`). When called, the agent emits the question as an event, sets the session to an awaiting state, and blocks (reusing the `controls`/poll mechanism, or accepting the answer as a `user_message`) until the operator answers; the answer enters the LLM thread and the turn resumes. Decide the exact carrier (new control vs. `user_message`) during implementation — keep it within the existing gate/poll machinery (R15).
**Patterns to follow:** `intercept.ts` polling loop; `user_message` handling in `context.ts`; the `awaiting-approval` status pattern.
**Test scenarios:**
- Covers AE4. A turn whose fake driver calls `ask_user` emits the question, sets the awaiting state, and does not proceed until an answer arrives; after the answer, the next turn sees it in context.
- The operator's answer is projected into the LLM thread (context.ts) as a user turn.
- `classifyTool('ask_user')` resolves to a gated/awaiting policy consistent with the design (assert via schema).
- Web renders the pending question with an answer affordance while awaiting.
**Verification:** agent + web suites pass; an agent missing a needed detail asks and waits rather than guessing.

### U8. Git working-set diff tool

**Goal:** Give the agent (and, later, the UI) a tool that reports the workspace's current git diff.
**Requirements:** R12
**Dependencies:** U3
**Files:**
- `packages/schema/src/tools.ts` (register `git_diff`, read-only policy)
- `apps/agent/src/tools/index.ts` + tool impl (run `git diff` within the workspace root, bounded)
- `apps/agent/src/tools/<git>.test.ts`
**Approach:** Add a read-only `git_diff` tool that runs `git diff` (optionally `--staged` / path-scoped) inside `ctx.root`, returning the unified diff text; degrade gracefully when the workspace is not a git repo. Read-only ⇒ no gate.
**Patterns to follow:** existing read-only tool impls (`grep`/`glob`) and the `safeJoin`/workspace-root guard; `run_command` spawn pattern.
**Test scenarios:**
- In a git workspace with an uncommitted change, `git_diff` returns a unified diff naming the changed file.
- In a non-git workspace, it returns a clear "not a git repository" message rather than throwing.
- Path traversal outside the workspace root is rejected.
**Verification:** agent suite passes; the tool returns real working-tree diffs.

### U9. Write-side LSP tools

**Goal:** Extend the read-only LSP with `rename_symbol`, `format`, and `code_action`.
**Requirements:** R13, R15
**Dependencies:** U3
**Files:**
- `packages/schema/src/tools.ts` (register the three, side-effecting policy)
- `apps/agent/src/tools/lsp.ts` (covered helper layer)
- `apps/agent/src/lsp.ts` (excluded boundary)
- `apps/agent/src/tools/lsp.test.ts` (fakes)
**Approach:** Mirror the existing read-only LSP split (covered `tools/lsp.ts` + excluded `lsp.ts` boundary). The three are file-mutating ⇒ side-effecting ⇒ gated like edits, and should surface before/after where feasible so U6's diff-review applies. Degrade gracefully when no language server is available (consistent with the existing `STEER_LSP` gating).
**Patterns to follow:** the read-only LSP tools (`diagnostics`/`definition`/`references`/`hover`) covered-helper-over-excluded-boundary pattern.
**Test scenarios:**
- `rename_symbol` with a fake LSP returns the edited result; the tool is classified side-effecting (gated).
- `format` returns formatted content from the fake; a no-op format returns unchanged content.
- `code_action` with no available action returns a clear message; with one, applies it.
- When the language server is unavailable, each tool degrades gracefully (no throw).
**Verification:** agent suite passes at coverage; the new tools route through the gate and produce reviewable changes.

### U10. Vision input

**Goal:** Let the operator attach an image to a task/message and let the agent read it on vision-capable providers.
**Requirements:** R14, R16
**Dependencies:** U3
**Files:**
- `packages/schema/src/schema.ts` + `zod.ts` (carry an image reference on the task/`user_message` payload)
- `apps/server/src/writes.ts` (accept image on session create / message)
- `apps/web/src/components/NewSessionModal.tsx` + `apps/web/src/components/SessionDetail.tsx` (image attach in composer)
- `apps/agent/src/context.ts` + `apps/agent/src/model.ts` (include the image in the model message for vision-capable providers)
- test files alongside (schema, server writes, web composer, context projection)
**Approach:** Allow an image to ride a task or follow-up message; persist it (within the Electric-synced event/row model) and project it into the LLM message as an image part when the provider/model supports vision, degrading to "image input unavailable" otherwise. Keep payloads bounded — large images add Postgres + Electric sync weight (see Risks); a size cap is a planning-time guardrail.
**Patterns to follow:** existing `user_message`/task write path in `apps/server/src/writes.ts`; `context.ts` message projection.
**Test scenarios:**
- A task created with an attached image persists the image reference and projects an image part into context for a vision-capable provider.
- A non-vision provider drops the image gracefully and notes it (no throw, agent still runs).
- An over-cap image is rejected at the boundary with a clear message.
- Web composer attaches and previews an image; it reaches the write path.
**Verification:** server + web + agent suites pass; on a vision provider the agent can reference an attached screenshot.

### Phase D — Verification

### U11. End-to-end capstone + changelog/docs

**Goal:** Prove the integrated live experience against the real event log and document the user-visible changes.
**Requirements:** all; AE1–AE6
**Dependencies:** U4, U5, U6, U7 (and U8–U10 where landed)
**Files:**
- `apps/agent/src/e2e.test.ts` (extend the DB-backed capstone)
- `apps/web/e2e/` (Playwright two-window streaming/diff-review flow, mirroring the existing two-window e2e)
- `docs/changelog/2026-06-05-live-agent-experience.md` (new)
- `README.md` (demo notes / what to watch for)
**Approach:** Drive a full streaming session through the real `tools` + `createDbStore` + a streaming driver script: reasoning streams (deltas → coalesced), multiple tool calls in a turn, a gated edit reviewed and approved, an `ask_user` answered, a verify run, ending `completed`. Assert the **real event log** (delta rows, preserved reasoning beside tool calls, multi-tool batch, approval-gated edit, final status) per the repo rule (assert DB fetches, not inferred outputs). Add a Playwright flow proving the live streaming + diff-review UX across two windows. Changelog + README cover the user-visible features.
**Patterns to follow:** existing `e2e.test.ts` / `loop.test.ts` DB-backed harness; the existing two-window Playwright e2e; the prior parity changelog.
**Test scenarios:**
- Covers AE1–AE6. The capstone asserts: streamed deltas coalesce; reasoning persists beside tool calls; a multi-tool turn records all results; a gated edit applies only after approve; `ask_user` blocks then resumes; the session ends `completed`.
- Playwright: window A streams a session live (text appears incrementally, a diff is approved); window B sees the synced result.
**Verification:** the capstone and e2e pass against the throwaway Postgres; changelog/README updated.

---

## Key Technical Decisions

- **Stream via `streamText`/`fullStream` with tools declared without `execute`.** The AI SDK v4 returns tool calls to the caller when a tool has no `execute`, so the loop keeps ownership of execution and interception while the SDK streams `reasoning`/`text-delta`/`tool-call` parts. (Verified against `ai@4.x` docs.)
- **Streaming rides Electric row-sync as coarse delta events — no new transport.** The PRD bans websockets; deltas are ordinary `events` rows. Chunk at buffer-flush granularity (not per-token) to bound event-log growth. "Token-by-token" is smooth chunks, not literal per-token.
- **Interception is unchanged.** The `controls` gate (`approve`/`reject`/`override`/`interrupt`, polled per `toolCallId`) is reused as-is. Multi-tool turns serialize side-effecting calls at the gate; only reads parallelize. (origin R15)
- **Verify-after-edit is prompt-steered, not structurally enforced.** Per the brainstorm's resolved fork — strengthen the system prompt rather than blocking completion. (origin R6 / Resolve-Before-Planning)
- **Reasoning is preserved.** `decide.ts`'s "discard text when a tool call is present" is removed — the core fix for the "silent" failure. (origin R2)
- **Covered-loop / excluded-driver split is kept.** `model.ts` stays coverage-excluded; the rebuilt loop is tested with a fake streaming driver (successor to `ScriptedModel`), preserving the 100 / branches-90 gate.

---

## Scope Boundaries

### Deferred to Follow-Up Work

- Multi-pane **workbench** (live changed-files panel + separate verify/terminal pane) — builds on U8's `git_diff`; not this plan.
- **Checkpoint / revert** (snapshot before a batch and roll back the agent).
- **Semantic `search_code`** (pgvector) — grep/glob remain the search path; separate plan `docs/plans/2026-06-03-003-feat-native-semantic-code-search-plan.md` exists.

### Non-goals

- No `apply_patch` edit-format change, structured `run_tests` tool, or notebook/file-move tools — `multi_edit`/`run_command`/`bash` already cover these.
- No changes to auth, the sync transport, or infra; no new banned dependencies (no Next.js, websockets, non-postgres DB, or coding-agent SDK).

---

## Risks & Mitigations

- **Event-log explosion from fine-grained deltas** → chunk reasoning/text at buffer-flush granularity, not per-token; cap delta size; coalesce to a terminal event on turn finish. (U1, U3)
- **Mid-stream approval interleaving** → deltas emit between `tool_proposed` and `tool_result`; the gate stays atomic per tool. Pause the stream at the tool boundary, gate, resume. (U3)
- **Coverage gate on a bigger loop** → the loop stays covered via a fake streaming driver; only `model.ts` (excluded) holds the real SDK wiring. Branch-90 leaves room for streaming error paths. (U2, U3)
- **Vision image weight in Postgres + Electric** → size cap + bounded payloads; degrade gracefully on non-vision providers. (U10)
- **Provider capability variance** (parallel tool calls, reasoning streaming, vision) → feature-detect and degrade; the loop must not assume any single provider's behavior. (U2, U10)
- **Partial-markdown rendering mid-stream** (unterminated code fences) → renderer must tolerate incremental input. (U5)

---

## Dependencies / Assumptions

- `ai@^4.x` `streamText`/`fullStream` with tools-without-execute (verified). New web deps: a markdown renderer, a syntax highlighter, a list virtualizer (exact choices are implementation-time).
- The `controls` approval gate and Electric event-sync model are reused unchanged; new event types extend the existing `events` table (already in the `proxy.ts` `COLLECTIONS` allowlist).
- Take-home constraints hold: `docker compose up` with only a `.env`, no host config, 100% TypeScript, agent stays portless/outbound-only.

---

## Deferred to Implementation

- Exact new event-type names and whether a DB migration is needed (depends on whether `events.type` has a DB-level constraint).
- Delta chunk-flush granularity (size/timing) tuned against perceived smoothness vs. row count.
- The `ask_user` answer carrier (new control vs. `user_message`) and exact awaiting status.
- Specific markdown / syntax-highlight / virtualization / diff libraries and sanitization strategy.
- Image persistence shape (payload column vs. reference) and size cap value.
- How `streamText` `finish`/usage maps onto turn-completion and the existing `maxSteps` cursor.

---

## Verification Strategy

- Agent units (U1, U3, U7–U10) are DB-backed against the throwaway Postgres (`TEST_DATABASE_URL`), asserting the **real event log** — no inferred outputs (repo rule). The rebuilt loop is exercised with a fake streaming driver.
- Web units (U4–U6) meet the `@steer/web` 100 / branches-90 gate; Electric sync + the live flow are proven by the U11 Playwright two-window e2e.
- `model.ts` (driver) stays coverage-excluded and is validated by the U11 capstone + the `docker compose up` demo.
- A changelog entry and README demo notes ship with U11 for the reviewer.
