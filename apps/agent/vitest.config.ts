import { defineConfig } from 'vitest/config'

// Integration test files share one Postgres database and each resets the schema
// in beforeAll — run files sequentially so they don't race on the reset.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
