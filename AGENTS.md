Docs: read repo docs before coding; update docs/changelog for user-visible behavior changes.

Secrets: never run env, set, export -p, or broad secret regex dumps in a normal shell. Query exact names only; redact values.

- do not check any environment variable ".env" ".env*" "secrets" "env/" file or folder ever.
- create unit tests for every bug, fix, feature
- create an evaluation test for every user-facing agent call with golden sets.
- do not accept smoke tests as "test driven development". TDD requires one of unit, integration, e2e tests.
- do not use inference for test outputs, use database fetches/results