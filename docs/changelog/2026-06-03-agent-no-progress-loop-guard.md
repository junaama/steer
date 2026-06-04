---
date: 2026-06-03
area: agent
---

# Agent stops on a no-progress loop

- The agent now stops a run as soon as the model re-proposes a tool call that has already returned the same result 3 times in a row (a stuck loop), with a message explaining why — instead of spinning identical calls until the `STEER_MAX_STEPS` cap.
- Differing results (e.g. polling a file as it changes) count as progress and don't trip the guard.
- Fixed the README's stated step cap (`STEER_MAX_STEPS`) to match the actual default of 80.
