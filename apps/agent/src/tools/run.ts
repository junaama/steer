import { spawn } from 'node:child_process'
import { validateToolArgs } from '@steer/schema'
import type { ToolFn } from './index.js'

export const COMMAND_OUTPUT_LIMIT = 16 * 1024
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

export interface ShellCommandOptions {
  command: string
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
  defaultTimeoutMs?: number
  appendExitCode: 'always' | 'nonzero'
}

function appendWithLimit(current: string, chunk: string): { out: string; truncated: boolean } {
  if (current.length >= COMMAND_OUTPUT_LIMIT) return { out: current, truncated: true }
  const remaining = COMMAND_OUTPUT_LIMIT - current.length
  if (chunk.length <= remaining) return { out: current + chunk, truncated: false }
  return { out: current + chunk.slice(0, remaining), truncated: true }
}

function finishOutput(
  out: string,
  exitCode: number,
  timeoutMs: number | undefined,
  truncated: boolean,
  appendExitCode: 'always' | 'nonzero',
): string {
  const lines: string[] = []
  if (out.length > 0) lines.push(out)
  if (truncated) lines.push(`[truncated to ${COMMAND_OUTPUT_LIMIT} chars]`)
  if (timeoutMs !== undefined) lines.push(`[timeout after ${timeoutMs}ms]`)
  if (appendExitCode === 'always' || exitCode !== 0) lines.push(`[exit ${exitCode}]`)
  return lines.join('\n')
}

export function runShellCommand(opts: ShellCommandOptions): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const timeoutMs = opts.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const child = spawn('sh', ['-c', opts.command], { cwd: opts.cwd, signal: opts.signal })
    let out = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const timeout = setTimeout(() => {
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
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      const exitCode = timedOut ? 1 : (code ?? 1)
      resolvePromise(finishOutput(out, exitCode, timedOut ? timeoutMs : undefined, truncated, opts.appendExitCode))
    })
  })
}

export const run_command: ToolFn = (args, ctx) =>
  Promise.resolve().then(() => {
    const { command, timeoutMs } = validateToolArgs('run_command', args) as {
      command: string
      timeoutMs?: number
    }
    return runShellCommand({
      command,
      cwd: ctx.workspaceRoot,
      signal: ctx.signal,
      timeoutMs,
      appendExitCode: 'always',
    })
  })
