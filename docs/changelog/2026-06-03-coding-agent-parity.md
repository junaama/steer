# Coding Agent Parity

- Self-verify sessions can now plan, edit, run commands, inspect failures, fix, and rerun verification in one durable loop. `run_command` approvals can be marked per-session auto-approve so repeated verification commands do not pause again.
- The live plan panel reflects `todo_write` updates as the agent works, keeping the session's current checklist visible in the web UI.
- Task subagents now stream nested traces under the parent task call, so delegated work remains readable without flattening the event log.
- Read-only LSP tools are available behind `STEER_LSP=1`: diagnostics, definition, references, and hover.
- MCP client tools are available behind `STEER_MCP_SERVERS`, with gated execution and dedicated web icons for dynamic `mcp:` tools.
- Surgical file-edit diffs are covered separately in `2026-06-03-surgical-file-edits.md`.
