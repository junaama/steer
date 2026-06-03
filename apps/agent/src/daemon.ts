import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inArray } from 'drizzle-orm'
import { sessions } from '@steer/schema'
import type { Db } from './db.js'
import { createDbStore } from './store.js'
import { runSession } from './loop.js'
import { tools } from './tools/index.js'
import { createAnthropicDriver } from './model-anthropic.js'

/**
 * Pick up sessions that need work and run them. 'starting' is a fresh task;
 * 'running' on daemon boot is a crashed run to resume (crash-only resume reads
 * the event log). `active` guards against double-running within this process.
 */
export async function pollAndRun(db: Db, active: Set<string>): Promise<void> {
  const store = createDbStore(db)
  const rows = await db.select().from(sessions).where(inArray(sessions.lastStatus, ['starting', 'running']))
  for (const s of rows) {
    if (active.has(s.id)) continue
    active.add(s.id)
    void (async () => {
      try {
        const workspaceRoot = await mkdtemp(join(tmpdir(), `steer-${s.id}-`))
        const driver = createAnthropicDriver({ model: s.model, task: s.task })
        await runSession(store, driver, s.id, { workspaceRoot, tools })
      } catch {
        await store.setStatus(s.id, 'error')
      } finally {
        active.delete(s.id)
      }
    })()
  }
}
