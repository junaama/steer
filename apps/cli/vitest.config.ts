import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts is the executable entry (readline TTY + process wiring) — exercised
      // by hand, not unit tests.
      exclude: ['**/*.test.ts', 'src/main.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
      reporter: ['text-summary'],
    },
  },
})
