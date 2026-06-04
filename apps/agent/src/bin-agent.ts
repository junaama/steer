#!/usr/bin/env node
import { resolveEnvironmentId } from '@steer/schema'
import { startDaemon } from './start.js'

// `steer-agent [--env <id>]` — run a local daemon bound to an environment, so a
// session tagged with that env runs against THIS machine's filesystem (PRD 3c:
// "as simple as a CLI command"). Falls back to STEER_ENV, else the default daemon.
const argv = process.argv.slice(2)
const flag = argv.indexOf('--env')
const envArg = flag >= 0 ? argv[flag + 1] : process.env.STEER_ENV
startDaemon({ env: resolveEnvironmentId(envArg) })
