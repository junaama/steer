import { login, run, watch, whoami, logout, ls, type Ctx } from './commands.js'

export const VERSION = '0.0.0'

export type Command = 'login' | 'signup' | 'logout' | 'whoami' | 'run' | 'watch' | 'ls' | 'help' | 'version'

export interface Flags {
  serverUrl?: string
  model?: string
  email?: string
  password?: string
  session?: string
  env?: string
  watch?: boolean
  signup?: boolean
  help?: boolean
  version?: boolean
}

export interface ParsedArgs {
  command: Command
  prompt: string
  sessionId: string
  flags: Flags
}

const VALUE_FLAGS = new Set(['--server', '--model', '--email', '--password', '--session', '--env'])
const COMMANDS = new Set(['login', 'signup', 'logout', 'whoami', 'run', 'watch', 'ls', 'help', 'version'])

function setValueFlag(flags: Flags, key: string, val: string): void {
  if (key === '--server') flags.serverUrl = val
  else if (key === '--model') flags.model = val
  else if (key === '--email') flags.email = val
  else if (key === '--password') flags.password = val
  else if (key === '--session') flags.session = val
  else if (key === '--env') flags.env = val
}

/**
 * Parse argv into a command. A bare first arg that isn't a known command is
 * treated as a prompt, so `steer "fix the flaky test"` just runs.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Flags = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok === '--watch') flags.watch = true
    else if (tok === '--signup') flags.signup = true
    else if (tok === '--help' || tok === '-h') flags.help = true
    else if (tok === '--version' || tok === '-v') flags.version = true
    else if (VALUE_FLAGS.has(tok)) {
      const val = argv[i + 1]
      i++
      if (val !== undefined) setValueFlag(flags, tok, val)
    } else if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=')
      setValueFlag(flags, tok.slice(0, eq), tok.slice(eq + 1))
    } else if (!tok.startsWith('-')) {
      positionals.push(tok)
    }
  }

  if (flags.help) return { command: 'help', prompt: '', sessionId: '', flags }
  if (flags.version) return { command: 'version', prompt: '', sessionId: '', flags }

  const first = positionals[0]
  if (first !== undefined && COMMANDS.has(first)) {
    const command = first as Command
    if (command === 'run') return { command, prompt: positionals.slice(1).join(' '), sessionId: '', flags }
    if (command === 'watch') return { command, prompt: '', sessionId: positionals[1] ?? '', flags }
    return { command, prompt: '', sessionId: '', flags }
  }
  if (positionals.length === 0) return { command: 'help', prompt: '', sessionId: '', flags }
  return { command: 'run', prompt: positionals.join(' '), sessionId: '', flags }
}

export function resolveServerUrl(flags: Flags, env: NodeJS.ProcessEnv): string {
  return flags.serverUrl ?? env.STEER_SERVER_URL ?? 'http://localhost:8080'
}

export function usage(): string {
  return [
    'steer — start and watch headless coding-agent sessions',
    '',
    'Usage:',
    '  steer login                 Log in (prompts for email + password)',
    '  steer signup                Create an account',
    '  steer "<prompt>"            Start a session from a prompt',
    '  steer "<prompt>" --env <id> Run it in a named environment (that machine\'s files)',
    '  steer "<prompt>" --watch    Start and stream the run in your terminal',
    '  steer "<prompt>" --session <id|name>   Send a follow-up to an existing session',
    '  steer ls                    List your sessions',
    '  steer watch <session-id>    Stream an existing session',
    '  steer whoami                Show the logged-in account',
    '  steer logout                Log out',
    '',
    'Flags:',
    '  --server <url>   API server (default $STEER_SERVER_URL or http://localhost:8080)',
    '  --model <tier>   sonnet | opus | haiku (default sonnet)',
    '  --session <ref>  Target an existing session by id or name (follow-up turn)',
    '  --env <id>       Route a new session to an environment; sticky once set.',
    '                   Run a daemon there with: steer-agent --env <id>',
    '  --email <e>      Non-interactive email (or $STEER_EMAIL)',
    '  --password <p>   Non-interactive password (or $STEER_PASSWORD)',
    '  --watch          Stream events after starting',
  ].join('\n')
}

export async function dispatch(parsed: ParsedArgs, ctx: Ctx, env: NodeJS.ProcessEnv): Promise<number> {
  switch (parsed.command) {
    case 'help':
      ctx.io.print(usage())
      return 0
    case 'version':
      ctx.io.print(VERSION)
      return 0
    case 'login':
    case 'signup':
      return login(ctx, {
        serverUrl: resolveServerUrl(parsed.flags, env),
        email: parsed.flags.email ?? env.STEER_EMAIL,
        password: parsed.flags.password ?? env.STEER_PASSWORD,
        signup: parsed.command === 'signup' || parsed.flags.signup,
      })
    case 'run':
      return run(ctx, {
        prompt: parsed.prompt,
        model: parsed.flags.model,
        watch: parsed.flags.watch,
        session: parsed.flags.session,
        env: parsed.flags.env,
      })
    case 'ls':
      return ls(ctx)
    case 'watch':
      if (!parsed.sessionId) {
        ctx.io.error('Usage: steer watch <session-id>')
        return 1
      }
      return watch(ctx, { sessionId: parsed.sessionId })
    case 'whoami':
      return whoami(ctx)
    case 'logout':
      return logout(ctx)
  }
}
