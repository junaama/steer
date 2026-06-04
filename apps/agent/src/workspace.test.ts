import { describe, it, expect } from 'vitest'
import { resolveWorkspaceRoot, resolveSessionWorkspace } from './workspace.js'

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

describe('resolveSessionWorkspace', () => {
  it('runs the session in its workdir when it is inside the root', () => {
    expect(resolveSessionWorkspace('/', '/dev/projectA')).toBe('/dev/projectA')
    expect(resolveSessionWorkspace('/home/me', '/home/me/projectA')).toBe('/home/me/projectA')
  })

  it('falls back to the root when no workdir is given', () => {
    expect(resolveSessionWorkspace('/dev', null)).toBe('/dev')
    expect(resolveSessionWorkspace('/dev', undefined)).toBe('/dev')
  })

  it('ignores a workdir outside the root (a daemon can only serve its own root)', () => {
    expect(resolveSessionWorkspace('/home/me', '/etc')).toBe('/home/me')
    expect(resolveSessionWorkspace('/home/me', '/home/other/proj')).toBe('/home/me')
  })

  it('normalizes and accepts the root itself as a workdir', () => {
    expect(resolveSessionWorkspace('/dev', '/dev')).toBe('/dev')
    expect(resolveSessionWorkspace('/dev', '/dev/projectA/../projectB')).toBe('/dev/projectB')
  })
})
