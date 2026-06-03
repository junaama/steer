import { describe, it, expect } from 'vitest'
import { resolveWorkspaceRoot } from './workspace.js'

describe('resolveWorkspaceRoot', () => {
  it('defaults to the daemon working directory', () => {
    expect(resolveWorkspaceRoot({}, () => '/work')).toBe('/work')
  })

  it('honors STEER_WORKSPACE_ROOT when set', () => {
    expect(resolveWorkspaceRoot({ STEER_WORKSPACE_ROOT: '/repo' }, () => '/work')).toBe('/repo')
  })

  it('treats empty / whitespace as unset (docker injects "")', () => {
    expect(resolveWorkspaceRoot({ STEER_WORKSPACE_ROOT: '' }, () => '/work')).toBe('/work')
    expect(resolveWorkspaceRoot({ STEER_WORKSPACE_ROOT: '   ' }, () => '/work')).toBe('/work')
  })

  it('uses the real process cwd by default', () => {
    expect(resolveWorkspaceRoot({})).toBe(process.cwd())
  })
})
