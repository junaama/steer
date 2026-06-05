import type { Db } from './db.js'
import { createDbStore, type AgentStore } from './store.js'
import { runSession } from './loop.js'
import { tools } from './tools/index.js'
import { buildMcpToolDefinitions, buildMcpTools, parseMcpConfig } from './tools/mcp.js'
import { connectMcpServers } from './mcp.js'
import { createModelDriver, createSubagentDriver } from './model.js'
import { resolveWorkspaceRoot, resolveSessionWorkspace } from './workspace.js'
import type { SessionIntent } from './intake.js'
import type { SubagentDriverInput } from './subagent.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Injectable seam so the claim gate is testable without a DB or a real model. */
export interface RunnerDeps {
  store: AgentStore
  runOne: (store: AgentStore, intent: SessionIntent) => Promise<void>
}

/**
 * Build the callback the Electric intake invokes for each runnable session.
 *
 * Before running, the daemon makes a single-owner CLAIM (`owner` = this daemon's
 * stable environment identity). Only the winner runs, so two daemons never
 * double-run the same session — this is what makes "run it anywhere" safe with
 * more than one daemon connected. `active` additionally guards re-entry within
 * this process (the sessions shape re-delivers a row on every status change, and
 * 'running' rows replay in the reconnect snapshot for crash-only resume).
 *
 * MCP servers are connected once per daemon (outbound only); their tools are
 * merged into each session's toolset.
 */
export function createRunner(
  db: Db,
  active: Set<string>,
  owner: string,
  deps?: Partial<RunnerDeps>,
): (intent: SessionIntent) => void {
  const store = deps?.store ?? createDbStore(db)
  const mcpConnections = connectMcpServers(parseMcpConfig(process.env)).catch((err: unknown) => {
    console.warn(`MCP unavailable; continuing with static tools: ${errorMessage(err)}`)
    return []
  })

  // Default per-session runner: run the coding loop in the daemon's own
  // environment (cwd), with the connected MCP tools merged in. Operates on the
  // real files where the daemon was launched (PRD: "runs the sessions on the host
  // it's running on").
  const defaultRunOne = async (s: AgentStore, intent: SessionIntent): Promise<void> => {
    // The daemon's root is the sandbox boundary; the session runs in its workdir
    // (the CLI's cwd) within that root — or at the root when no workdir was given.
    const root = resolveWorkspaceRoot(process.env)
    const workspaceRoot = resolveSessionWorkspace(root, intent.workdir)
    const maxSteps = Number(process.env.STEER_MAX_STEPS) || 80
    const connections = await mcpConnections
    const dynamicTools = buildMcpTools(connections)
    const dynamicToolDefinitions = buildMcpToolDefinitions(connections)
    const sessionTools = { ...tools, ...dynamicTools }
    const driver = createModelDriver({ model: intent.model, task: intent.task, taskImage: intent.taskImage, dynamicTools: dynamicToolDefinitions })
    const subagentDriver = (input: SubagentDriverInput) =>
      createSubagentDriver({ ...input, model: intent.model, dynamicTools: dynamicToolDefinitions })
    await runSession(s, driver, intent.id, { workspaceRoot, root, tools: sessionTools, maxSteps, subagentDriver })
  }
  const runOne = deps?.runOne ?? defaultRunOne

  return (intent) => {
    if (active.has(intent.id)) return
    active.add(intent.id)
    void (async () => {
      try {
        // The claim is a pre-run GATE. A lost claim (another daemon owns it) or a
        // transient claim error is a no-op — never mark the session errored here,
        // since it may be actively running on its real owner (setStatus has no
        // owner guard). Only a failure of the actual run errors the session.
        let won = false
        try {
          won = await store.claimSession(intent.id, owner)
        } catch (err) {
          // A transient claim error is a no-op (the session may be running on its
          // real owner), but log it so a persistently failing claim is visible.
          console.warn(`[agent] claim failed for ${intent.id}: ${errorMessage(err)}`)
          return
        }
        if (!won) return
        try {
          await runOne(store, intent)
        } catch (err) {
          // Surface the cause: a swallowed run failure (bad model creds, a tool
          // throw) otherwise leaves the session 'error' with no diagnostic.
          console.error(`[agent] session ${intent.id} failed: ${errorMessage(err)}`, err)
          await store.setStatus(intent.id, 'error')
        }
      } finally {
        active.delete(intent.id)
      }
    })()
  }
}
