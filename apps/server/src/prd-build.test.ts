import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * PRD: "builds locally" — the project must compile. This runs the same strict
 * typecheck a reviewer would across every workspace package. Slow by nature
 * (it invokes the whole-repo build), so it carries a generous timeout.
 */
const REPO = resolve(process.cwd(), '../..')

describe('PRD: builds locally (code-quality, C1, C12)', () => {
  it('typechecks every workspace package', () => {
    expect(() => execSync('pnpm -r typecheck', { cwd: REPO, stdio: 'pipe' })).not.toThrow()
  }, 240_000)
})
