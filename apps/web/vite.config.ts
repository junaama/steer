import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Read VITE_* from the repo-root .env / .env.local (same files docker compose
  // uses) so `pnpm --filter @steer/web dev` picks up VITE_SERVER_URL on the host.
  envDir: '../../',
  // PORT lets host dev avoid a busy 5173 (`PORT=5180 pnpm --filter @steer/web dev`)
  // without fighting pnpm's `--` arg forwarding. Docker serves via the `preview`
  // script's own --port flag, so this only affects the dev server.
  server: { host: '0.0.0.0', port: Number(process.env.PORT) || 5173 },
  preview: { host: '0.0.0.0', port: 5173 },
})
