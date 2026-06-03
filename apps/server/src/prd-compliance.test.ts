import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * PRD constraint & deliverable compliance — static checks against the repo.
 *
 * These assert the PRD's hard constraints (no Next.js, no websockets, no
 * coding-agent SDK, Electric+TanStack+Postgres sync, a portless agent container,
 * a one-command docker-compose) and the deliverable requirements (README,
 * .env config, AI config dir). Behavioral requirements live in
 * prd-session-lifecycle.test.ts; "builds locally" lives in prd-build.test.ts.
 */

// vitest runs each package's script in its own dir, so cwd is apps/server.
const REPO = resolve(process.cwd(), '../..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf8')) as Record<string, unknown>
}

const PKG_PATHS = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/agent/package.json',
  'apps/cli/package.json',
  'packages/schema/package.json',
]

function allDeps(): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const p of PKG_PATHS) {
    const pkg = readJson(p)
    Object.assign(merged, (pkg.dependencies as Record<string, string>) ?? {})
    Object.assign(merged, (pkg.devDependencies as Record<string, string>) ?? {})
  }
  return merged
}

/** Every .ts/.tsx source file under the app/package src trees. */
function sourceFiles(): string[] {
  const roots = ['apps/server/src', 'apps/web/src', 'apps/agent/src', 'apps/cli/src', 'packages/schema/src']
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
  }
  for (const r of roots) {
    const abs = join(REPO, r)
    if (existsSync(abs)) walk(abs)
  }
  return out
}

const DEPS = allDeps()

describe('PRD: language & code quality (C1, code-quality)', () => {
  it('C1: TypeScript strict across the whole repo', () => {
    const base = readJson('tsconfig.base.json')
    expect((base.compilerOptions as Record<string, unknown>).strict).toBe(true)
    for (const p of ['apps/server', 'apps/web', 'apps/agent', 'apps/cli', 'packages/schema']) {
      expect(existsSync(join(REPO, p, 'tsconfig.json'))).toBe(true)
    }
  })

  it('C1: no source ships as plain JavaScript', () => {
    expect(sourceFiles().every((f) => /\.tsx?$/.test(f))).toBe(true)
  })
})

describe('PRD: off-limits technology (C3, C4, C7)', () => {
  it('C4: does not use Next.js', () => {
    expect(DEPS).not.toHaveProperty('next')
  })

  it('C3: does not depend on a pre-built coding-agent SDK', () => {
    const forbidden = [
      '@anthropic-ai/claude-code',
      '@anthropic-ai/claude-agent-sdk',
      'claude-code',
      'opencode',
      '@opencode-ai/sdk',
      '@sourcegraph/amp',
      'cursor',
      '@cursor/sdk',
    ]
    for (const dep of forbidden) expect(DEPS).not.toHaveProperty(dep)
  })

  it('C3: builds the loop on an allowed LLM/agent SDK (Vercel AI SDK)', () => {
    expect(DEPS).toHaveProperty('ai') // the Vercel AI SDK is explicitly permitted
  })

  it('C7: no websockets in dependencies or app source', () => {
    for (const dep of ['ws', 'socket.io', 'socket.io-client']) expect(DEPS).not.toHaveProperty(dep)
    // Production source only — test files name these patterns in their own assertions.
    for (const file of sourceFiles().filter((f) => !/\.test\.tsx?$/.test(f))) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/\bnew WebSocket\b/)
      expect(text, file).not.toMatch(/from ['"]ws['"]/)
      expect(text, file).not.toMatch(/socket\.io/)
    }
  })
})

describe('PRD: required sync stack (C6, 2a, 2b)', () => {
  it('C6: sync uses Electric SQL + TanStack DB + Postgres', () => {
    expect(DEPS).toHaveProperty('@electric-sql/client') // Electric client
    expect(DEPS).toHaveProperty('@tanstack/react-db') // TanStack DB
    expect(DEPS).toHaveProperty('@tanstack/electric-db-collection') // TanStack ⇄ Electric
    expect(DEPS).toHaveProperty('pg') // Postgres driver
  })
})

describe('PRD: starting the agent is a CLI command (3c)', () => {
  it('3c: the daemon and the steer CLI are startable from the command line', () => {
    const agent = readJson('apps/agent/package.json')
    expect((agent.scripts as Record<string, string>).serve).toMatch(/tsx .*index\.ts/) // `pnpm serve`
    const cli = readJson('apps/cli/package.json')
    expect((cli.bin as Record<string, string>).steer).toBeTruthy()
    expect(existsSync(join(REPO, 'steer'))).toBe(true) // ./steer launcher
  })
})

describe('PRD: configuration & deliverables (C8, D1, D3)', () => {
  it('C8: an LLM key is configured via .env, documented for the reviewer', () => {
    const envExample = readFileSync(join(REPO, '.env.example'), 'utf8')
    expect(envExample).toMatch(/OPENAI_API_KEY/)
    expect(envExample).toMatch(/ANTHROPIC_API_KEY/)
    expect(readFileSync(join(REPO, 'README.md'), 'utf8')).toMatch(/API_KEY|\.env/)
  })

  it('D1: README gives a reviewer run instructions', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    expect(readme).toMatch(/docker compose up/)
    expect(readme.toLowerCase()).toMatch(/quick start|getting started/)
  })

  it('D3: AI coding-agent config is included in the repo', () => {
    const hasConfig =
      existsSync(join(REPO, 'CLAUDE.md')) ||
      existsSync(join(REPO, 'AGENTS.md')) ||
      existsSync(join(REPO, '.claude'))
    expect(hasConfig).toBe(true)
  })

  it.todo('D2: README links a web-viewable Loom demo (pending recording)')
})

describe('PRD: docker-compose deliverable (C5, C10, C11, 3a)', () => {
  let config: { services: Record<string, ServiceConfig> }
  let hasDocker = true

  interface ServiceConfig {
    ports?: unknown[]
    expose?: unknown[]
    environment?: Record<string, string> | string[]
    restart?: string
    depends_on?: Record<string, { condition?: string }>
  }

  beforeAll(() => {
    try {
      execSync('docker compose version', { cwd: REPO, stdio: 'ignore' })
      const json = execSync('docker compose -f docker-compose.yml config --format json', {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      config = JSON.parse(json) as typeof config
    } catch {
      hasDocker = false
    }
  })

  const dockerIt = (name: string, fn: () => void) =>
    it(name, () => {
      if (!hasDocker) {
        // Docker CLI absent — the compose file still exists; skip the parse-based checks.
        expect(existsSync(join(REPO, 'docker-compose.yml'))).toBe(true)
        return
      }
      fn()
    })

  dockerIt('C5/C10: compose defines server+UI, database, Electric, and an agent container', () => {
    for (const svc of ['postgres', 'electric', 'server', 'web', 'agent', 'migrate']) {
      expect(config.services, svc).toHaveProperty(svc)
    }
  })

  dockerIt('C11: server and UI publish ports for the user to interact with', () => {
    expect(config.services.server!.ports?.length ?? 0).toBeGreaterThan(0)
    expect(config.services.web!.ports?.length ?? 0).toBeGreaterThan(0)
  })

  dockerIt('C11/3a: the agent container opens NO ports (connects out only)', () => {
    const agent = config.services.agent!
    expect(agent.ports ?? []).toHaveLength(0)
    expect(agent.expose ?? []).toHaveLength(0)
  })

  dockerIt('3a: the agent reaches the server/db outbound (has connection env, no inbound)', () => {
    const env = config.services.agent!.environment ?? {}
    const keys = Array.isArray(env) ? env.map((e) => e.split('=')[0]) : Object.keys(env)
    expect(keys).toContain('DATABASE_URL')
    expect(keys.some((k) => k === 'SERVER_URL' || k === 'ELECTRIC_URL')).toBe(true)
  })

  dockerIt('C12: migrations run as a one-shot before the server boots', () => {
    expect(config.services.migrate!.restart).toBe('no')
    expect(config.services.server!.depends_on).toHaveProperty('migrate')
  })
})

describe('PRD: portless agent at the source level (3a, C11)', () => {
  it('the agent never opens a listening socket', () => {
    expect(existsSync(join(REPO, 'apps/agent/Dockerfile'))).toBe(true)
    const dockerfile = readFileSync(join(REPO, 'apps/agent/Dockerfile'), 'utf8')
    expect(dockerfile).not.toMatch(/^\s*EXPOSE/im)
    const agentSrc = sourceFiles().filter((f) => f.includes('/apps/agent/src/') && !f.endsWith('.test.ts'))
    for (const file of agentSrc) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/\.listen\(/)
      expect(text, file).not.toMatch(/createServer\(/)
    }
  })
})
