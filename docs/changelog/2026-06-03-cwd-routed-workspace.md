---
date: 2026-06-03
area: agent, cli, server
---

# `steer` runs in the directory you call it from

- `./steer "…"` now binds the session to the CLI's current working directory (a new `workdir` on the session), so the agent operates on *your* files by default instead of the container's `/workspace`. `--workdir <dir>` overrides it.
- The daemon now distinguishes its **root** (sandbox boundary) from each session's **working directory**. A session resolves relative paths against its workdir but can reach any sibling directory under the root ("request broader scope"); it still cannot escape the root.
- The default `docker compose up` container mounts your **home directory at the same path** (no path translation) and roots the daemon there — Docker Desktop shares `/Users` by default and Linux mounts freely, so a freshly-pulled stack reaches your real projects with **no host configuration**. Narrow with `WORKSPACE_DIR=~/dev/app` or widen with `WORKSPACE_DIR=/` (the latter needs Docker file-sharing). `bash` is a real shell with the root's reach.
