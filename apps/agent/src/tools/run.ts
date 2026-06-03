import { spawn } from 'node:child_process'
import { validateToolArgs } from '@steer/schema'
import type { ToolFn } from './index.js'

const OUTPUT_LIMIT = 16 * 1024

function appendWithLimit(current: string, chunk: string): { out: string; truncated: boolean } {
  if (current.length >= OUTPUT_LIMIT) return { out: current, truncated: true }
  const remaining = OUTPUT_LIMIT - current.length
  if (chunk.length <= remaining) return { out: current + chunk, truncated: false }
  return { out: current + chunk.slice(0, remaining), truncated: true }
}

function finishOutput(out: string, exitCode: number, timeoutMs: number | undefined, truncated: boolean): string {
  const lines: string[] = []
  if (out.length > 0) lines.push(out)
  if (truncated) lines.push(`[truncated to ${OUTPUT_LIMIT} chars]`)
  if (timeoutMs !== undefined) lines.push(`[timeout after ${timeoutMs}ms]`)
  lines.push(`[exit ${exitCode}]`)
  return lines.join('\n')
}

export const run_command: ToolFn = (args, ctx) =>
  new Promise<string>((resolvePromise, reject) => {
    const { command, timeoutMs } = validateToolArgs('run_command', args) as {
      command: string
      timeoutMs?: number
    }
    const child = spawn('sh', ['-c', command], { cwd: ctx.workspaceRoot, signal: ctx.signal })
    let out = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill()
          }, timeoutMs)

    const append = (chunk: Buffer): void => {
      const next = appendWithLimit(out, chunk.toString())
      out = next.out
      truncated = truncated || next.truncated
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (err) => {
      if (timeout !== undefined) clearTimeout(timeout)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.on('close', (code) => {
      if (timeout !== undefined) clearTimeout(timeout)
      if (settled) return
      settled = true
      const exitCode = timedOut ? 1 : code ?? 1
      resolvePromise(finishOutput(out, exitCode, timedOut ? timeoutMs : undefined, truncated))
    })
  })
