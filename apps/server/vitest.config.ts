import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entrypoints, infra, type-only, and generators — not feature-bearing.
      exclude: ['**/*.test.ts', 'src/index.ts', 'src/migrate.ts', 'src/seed.ts', 'src/types.ts', 'src/db.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
      reporter: ['text-summary'],
    },
  },
})
