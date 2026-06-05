---
date: 2026-06-05
area: agent
---

# No-progress guard now stops varied-but-fruitless search

The agent's no-progress guard (`isNoProgressRepeat` in `apps/agent/src/loop.ts`)
previously only stopped a model that re-proposed the **identical** tool call
(`name` + `args`) with the same result `REPEAT_LIMIT` (3) times running. A model
that kept *searching* — same tool, fresh args each call, every result identically
fruitless — slipped through, because every `(name+args)` key differed. It then
flailed all the way to the step cap.

The eval suite caught this on a real SWE-bench instance (`psf__requests-1142`):
the agent ran `grep` for `content-length` over file after file, each returning the
identical `— no matches`, walking the 30-step cap with no edit instead of changing
strategy.

**Fix.** The guard now trips on two shapes once the last `REPEAT_LIMIT` calls all
returned the same result (no new information):

1. **Exact repeat** — the proposed call is identical to the recent ones (the
   original behavior; e.g. re-listing the same dir).
2. **Fruitless search** — the proposed call and the recent calls are all the
   **same search tool** (`grep` / `glob`) returning that identical fruitless
   result while only the args change.

`list_dir` is intentionally excluded from rule 2: switching to a new directory is
real exploration whose results normally differ, so the same-result check already
guards it without an args-agnostic rule. Differing results (a file polled as it
changes, or a search that finds varied matches) still count as progress and do
not trip the guard.

**Verified.** Deterministic unit + loop-level integration tests in
`apps/agent/src/loop.test.ts` cover the grep/glob varied-fruitless thrash, the
"results actually differ → progress" case, tool-switch reset, and the non-search
exclusions. Re-running the `psf__requests-1142` benchmark against the real agent,
the run now terminates via the no-progress guard ("Stopped: `grep` repeated 3×
with the same result and made no progress.") instead of the generic step-cap
timeout. The underlying localization miss is a separate model-capability limit,
not addressed here.
