import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    // unit/integration only — the Playwright e2e specs live under e2e/.
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Entrypoint + network/IO shells (the auth client, TanStack Electric)
      // verified by the two-window E2E, not unit tests.
      exclude: [
        '**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/App.tsx',
        'src/auth/AuthProvider.tsx',
        'src/data/electric.ts',
        'src/data/types.ts',
        'src/test-setup.ts',
      ],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
      reporter: ['text-summary'],
    },
  },
})
