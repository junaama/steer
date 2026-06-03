#!/usr/bin/env node
import readline from 'node:readline'
import { SteerClient } from './api.js'
import { parseArgs, dispatch } from './cli.js'
import type { Ctx, IO } from './commands.js'

function ask(label: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // Mask echo for password entry: write the label, then suppress subsequent output.
    const sink = rl as unknown as { _writeToOutput: (s: string) => void }
    const original = sink._writeToOutput.bind(rl)
    let mask = false
    sink._writeToOutput = (s: string): void => {
      if (!hidden || !mask) original(s)
    }
    rl.question(label, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
    mask = true
  })
}

const realIO: IO = {
  print: (s) => process.stdout.write(`${s}\n`),
  error: (s) => process.stderr.write(`${s}\n`),
  prompt: (label) => ask(label, false),
  promptHidden: (label) => ask(label, true),
}

const ctx: Ctx = {
  makeClient: (serverUrl) => new SteerClient({ serverUrl }),
  io: realIO,
}

dispatch(parseArgs(process.argv.slice(2)), ctx, process.env)
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`steer: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
