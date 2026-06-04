---
date: 2026-06-03
area: agent, cli, server
---

# `steer` runs in the directory you call it from

- `./steer "…"` now binds the session to the CLI's current working directory (a new `workdir` on the session), so the agent operates on *your* files by default instead of the container's `/workspace`. `--workdir <dir>` overrides it.
- The daemon now distinguishes its **root** (sandbox boundary) from each session's **working directory**. A session resolves relative paths against its workdir but can reach any sibling directory under the root ("request broader scope"); it still cannot escape the root.
- The default `docker compose up` container mounts the host filesystem at `/host` and roots the daemon there, so a freshly-pulled stack can serve any directory you run `steer` from. Whole-machine reach is intentional; narrow it with `WORKSPACE_DIR=<dir>`. `bash` remains an uncontained real shell.
