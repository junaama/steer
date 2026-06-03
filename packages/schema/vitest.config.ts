import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index re-exports + schema.ts (declarative drizzle table DDL).
      exclude: ['**/*.test.ts', 'src/index.ts', 'src/schema.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
      reporter: ['text-summary'],
    },
  },
})
