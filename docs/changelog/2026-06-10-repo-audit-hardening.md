# Repo Audit Hardening

- Browser writes can no longer forge agent events or directly mutate session status; interrupted sessions continue through the dedicated `/sessions/:id/continue` lifecycle endpoint.
- `bash` and `run_command` share bounded shell execution with a default timeout and output cap, so approved commands cannot hang or flood the session indefinitely.
- Destructive DB-backed tests default to package-local throwaway databases instead of the app's compose database.
- The reviewer compose path is more reproducible: Electric is pinned by digest and Docker builds use the pnpm lockfile.
- Production dependency audit no longer reports the previous high Drizzle advisory or moderate AI SDK transitive advisory; one low `@ai-sdk/provider-utils` advisory remains because the audit reports no patched range.
