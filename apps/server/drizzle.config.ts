import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../../packages/schema/src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
})
