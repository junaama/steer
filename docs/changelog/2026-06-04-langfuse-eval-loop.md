---
date: 2026-06-04
area: agent, evals
---

# Langfuse eval build-loop for the agent

The agent now has a committed evaluation suite under `apps/agent/evals/` that runs
the **real** `runSession` loop over hand-written goldens, reads the **actual event
log** (not inferred output), and scores it — so evals are a build-loop ground
truth, not just an end check.

- **Tracing (TypeScript, no Python).** `apps/agent/src/tracing.ts` boots a Langfuse
  OTel exporter, and the Vercel AI SDK calls in `model.ts` carry
  `experimental_telemetry` (gated — off unless `LANGFUSE_*` keys or `STEER_TRACING=1`
  are set, so production is unaffected). Each model call links to its Steer session.
- **Harness.** `evals/harness.ts` seeds a session in an isolated Postgres
  (`EVAL_DATABASE_URL`), runs the real loop against a committed fixture workspace
  scoped to `READ_ONLY_TOOLS` (so the model can't trip the approval gate, which would
  block an unattended run), then projects the real `tool_proposed` / `message` events
  into a result.
- **Evaluators** (`evals/evaluators.ts`, unit-tested): tool-correctness,
  task-completion, answer-relevancy — deterministic code scorers, no judge model.
- **Runner.** `pnpm --filter @steer/agent eval` runs the suite. With `LANGFUSE_*`
  set it pushes traces + scores to (self-hosted) Langfuse via
  `langfuse.experiment.run`; without keys it prints local scores so the loop works
  with only an LLM key + Postgres.

### First round found a real agent bug

The eval surfaced that the agent searched with the wrong idiom (`grep "def slugify"`,
`glob **/*.js`) in a TypeScript repo and kept exploring after it already had the
answer — thrashing to the step cap and erroring. Fix: a scoped `model.ts` system-prompt
change — search by the bare identifier (not `def`/`function`), don't assume the file
extension, and stop calling tools once a result answers the question. Re-running moved
task-completion 80→100% and answer-relevancy 70→90%.
