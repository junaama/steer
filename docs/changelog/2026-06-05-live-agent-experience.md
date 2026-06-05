---
date: 2026-06-05
area: agent, web
---

# Live agent experience overhaul

Watching a Steer session now feels like watching a live coding agent. The turn
loop streams, preserves the agent's reasoning, runs multiple tools per turn, and
the web renders the whole thing as a legible, reviewable transcript — all while
the per-tool approval gate and Electric event-sync model stay unchanged.

Each item below is a synced `events` row, so it streams to every open window with
no reload and survives a daemon restart (crash-only resume).

## Streaming reasoning + reply transcript

The assistant's reasoning and reply now stream in as they're generated, as coarse
`thinking_delta` / `message_delta` rows that coalesce into the terminal
`thinking` / `message` event on turn finish. No more blank wait then a wall of
text — the transcript fills in live and the concatenated deltas equal the final
message.

## Multi-tool turns

A single turn can propose several tool calls (e.g. read + grep + list in one go),
and the loop executes the whole batch — not just the first call. Read-only calls
run immediately; each side-effecting call still passes the approval gate.

## Reasoning shown, not discarded

The old loop dropped the model's text whenever a tool call was present. Reasoning
is now kept beside the tool call, so you can see *why* the agent is doing what it
is doing even on action turns.

## Markdown + syntax-highlighted code

Assistant and user messages render as markdown with language-aware syntax
highlighting for fenced code blocks, with safe defaults (no raw-HTML injection)
and tolerant of partial mid-stream markdown (an unterminated code fence won't
break rendering).

## Diff-review approvals

A `write_file` / `edit_file` / `multi_edit` proposal renders as a reviewable,
syntax-highlighted line-level **diff** (added / removed lines). You approve or
reject the actual change before it applies — the file is never written until you
approve. The underlying `controls` approve/reject gate is unchanged; only your
view of the proposal is upgraded.

## `ask_user` clarify

When the agent is missing a detail, it can call `ask_user` to pause and ask one
targeted question instead of guessing or giving up. The session parks
`awaiting-input` and resumes when you answer (a normal follow-up message), with
the answer projected into the model's context.

## `git_diff` working-set tool

A read-only `git_diff` tool reports the workspace's current git working-tree diff
(optionally staged / path-scoped), degrading gracefully when the workspace isn't a
git repo. Read-only, so it runs without a gate.

## Write-side LSP

The read-only LSP set (`diagnostics` / `definition` / `references` / `hover`) is
joined by write-side tools: `rename_symbol`, `format`, and `code_action`. These
mutate files, so they're gated like edits and surface as reviewable changes.
Degrades gracefully when no language server is available.

## Vision input

You can attach an image to a task or follow-up message. On a vision-capable
provider the agent reads it as an image part in the model message; on a non-vision
provider the image is dropped gracefully and noted, and oversized images are
rejected at the boundary.

## Verification

Proven end-to-end by a DB-backed capstone (`apps/agent/src/e2e.test.ts`) that
drives one streamed session — streamed reasoning + text deltas alongside a tool
call, a multi-tool turn, a gated edit reviewed and approved, an `ask_user`
answered, a verify run, ending `completed` — and asserts the **real event log**
read back from the store (no inferred outputs). A Playwright two-window spec
(`apps/web/e2e/live-stream.spec.ts`) proves the live-streaming + diff-review UX
syncs across windows.
