import type { Db } from './db.js'
import { createDbStore } from './store.js'
import { runSession } from './loop.js'
import { tools } from './tools/index.js'
import { createModelDriver } from './model.js'
import { resolveWorkspaceRoot } from './workspace.js'
import type { SessionIntent } from './intake.js'

/**
 * Build the callback the Electric intake invokes for each runnable session.
 * `active` guards against double-running within this process: the sessions
 * shape re-delivers a row on every status change, and 'running' rows replay in
 * the reconnect snapshot (crash-only resume) — both must be no-ops if the run
 * is already in flight here.
 */
export function createRunner(db: Db, active: Set<string>): (intent: SessionIntent) => void {
  const store = createDbStore(db)
  return (intent) => {
    if (active.has(intent.id)) return
    active.add(intent.id)
    void (async () => {
      try {
        // The coding agent runs in the daemon's own environment (cwd), so it
        // operates on the real files where it was launched (PRD: "runs the
        // sessions on the host it's running on").
        const workspaceRoot = resolveWorkspaceRoot(process.env)
        const maxSteps = Number(process.env.STEER_MAX_STEPS) || 40
        const driver = createModelDriver({ model: intent.model, task: intent.task })
        await runSession(store, driver, intent.id, { workspaceRoot, tools, maxSteps })
      } catch {
        await store.setStatus(intent.id, 'error')
      } finally {
        active.delete(intent.id)
      }
    })()
  }
}
