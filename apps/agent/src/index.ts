import { resolveEnvironmentId } from '@steer/schema'
import { startDaemon } from './start.js'

// Default daemon entry (docker / `pnpm serve`): routing id from STEER_ENV, else
// the default (unrouted) daemon that runs sessions created without an environment.
startDaemon({ env: resolveEnvironmentId(process.env.STEER_ENV) })
