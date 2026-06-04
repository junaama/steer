import { defineConfig } from 'vitest/config'

// Integration test files share one Postgres database and each resets the schema
// in beforeAll — run files sequentially so they don't race on the reset.
export default defineConfig({
  test: {
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entrypoints, poll daemon, external integration drivers (LLM/LSP/MCP), and DB infra.
      exclude: [
        '**/*.test.ts',
        'src/index.ts',
        'src/bin-agent.ts',
        'src/start.ts',
        'src/daemon.ts',
        'src/model.ts',
        'src/lsp.ts',
        'src/mcp.ts',
        'src/db.ts',
      ],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
      reporter: ['text-summary'],
    },
  },
})
