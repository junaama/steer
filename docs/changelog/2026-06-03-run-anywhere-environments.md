# Run It Anywhere — Environment-Bound Sessions

- Sessions can now be routed to a named **environment** with `steer "…" --env <id>` (sticky after first use). Exactly one daemon claims a session (single-owner), so viewing it and sending follow-ups always target that environment's filesystem — never the wrong machine.
- Run a daemon on your own machine with `steer-agent --env <id>` (or `pnpm --filter @steer/agent agent --env <id>`) so a session you start locally runs against your local files. See README → "Run it anywhere".
- A session whose environment has no daemon connected queues until one connects — starting the daemon there drains the queue.
- The `docker compose up` agent stays the **default daemon** (unrouted sessions, e.g. the web "New session"), so the single-container experience is unchanged. The web session view shows an `env: <id>` badge for routed sessions.
