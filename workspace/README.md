# Agent workspace

This directory is mounted into the agent container at `/workspace` and is where
the coding agent does its work (`read_file`, `list_dir`, `grep`, `write_file`,
`bash` all act here) — the same way `claude -p "…"` works in your current directory.

Point the agent at a real project instead:

```bash
WORKSPACE_DIR=~/dev/my-project docker compose up
# or your current directory, claude -p style:
WORKSPACE_DIR=$(pwd) docker compose up
```

Then start a session and watch it live:

```bash
./steer "add a health check endpoint" --watch    # CLI
# or open the web UI (http://localhost:5173) — your "remote control" for live sessions
```
