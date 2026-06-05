---
date: 2026-06-05
area: agent, evals
---

# Multi-turn (session history) eval + prompt fix for dropped goals

A real session (`sess-eeb54402`) exposed two agent failures: asked for the first
line of a README in a folder, the agent (a) couldn't find the folder at the named
path and **gave up** instead of searching, and (b) after the user supplied the
real path, it **described the folder instead of finishing the original task** —
dropping the goal across the follow-up turn.

`buildContext` was not at fault — it correctly keeps the original task as the
leading message across turns. The failures were agent behavior on a fragile
prompt, surfaced only on a "bad roll" of a nondeterministic model.

## New eval: conversation / session-history goldens

- `evals/conversation.ts` — multi-turn goldens: an original task plus follow-up
  user messages. One checks pure conversational memory; one reproduces the
  README-in-a-nested-folder scenario (`evals/fixtures/nested-repo/`), scored on
  whether the **final** answer (after all turns) contains the original answer.
- `evals/harness.ts` — `runConversationGolden` injects each follow-up as a
  `user_message` and resumes `runSession` with the original task, exactly as the
  daemon does on a real follow-up (`intake.ts` re-runs with `row.task`).
- `pnpm --filter @steer/agent eval:history` runs it (local scores).
- `src/context.test.ts` — a deterministic regression test locks the structural
  guarantee that the original task survives in context after a failed turn +
  clarification (the `sess-eeb54402` shape).

## Fix: prompt hardening (`model.ts`)

Two scoped additions to the agent system prompt:

1. **Search, don't give up.** If a file/folder isn't at the expected path, locate
   it with a single `glob` (matching its name) or `grep` before concluding it
   doesn't exist or asking the user.
2. **One conversation, one task.** When the user later supplies a correction or
   missing detail (e.g. a path), use it to COMPLETE the original request — don't
   just describe what was found or restate the message.

The `glob`-first steer also fixed an efficiency cliff: on the `sonnet` tier the
README scenario went from **8–18 `list_dir` calls** (thrash, on the edge of
giving up) to **2 calls** (`glob`, `read_file`), stable across re-runs.

## Verified

- Conversation eval: 100% completion / answer-relevancy on `haiku` and `sonnet`
  tiers; the README golden resolves in `glob, read_file` reproducibly.
- Single-turn goldens unchanged (80 / 100 / 90 — no regression).
- Full unit suite green; coverage 100% lines/functions/statements, 96.15%
  branches. `model.ts` is excluded from coverage (external integration boundary).
