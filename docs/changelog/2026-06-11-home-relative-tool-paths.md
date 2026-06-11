# Home-relative tool paths

- Agent file tools now expand `~/...` against the daemon host home directory while keeping the daemon root sandbox boundary.
- Added a conversation golden for sessions created in `~/dev/steer` so directory listing regressions are caught with real event-log scoring.
