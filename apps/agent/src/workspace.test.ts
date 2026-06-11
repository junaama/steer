import { describe, it, expect } from 'vitest'
import { resolveWorkspaceRoot, resolveSessionWorkspace } from './workspace.js'

describe('resolveWorkspaceRoot', () => {
  it('defaults to the daemon host root', () => {
    expect(resolveWorkspaceRoot({})).toBe('/')
  })

  it('honors STEER_WORKSPACE_ROOT when set', () => {
    expect(resolveWorkspaceRoot({ STEER_WORKSPACE_ROOT: '/repo' })).toBe('/repo')
  })

  it('treats empty / whitespace as unset (docker injects "")', () => {
    expect(resolveWorkspaceRoot({ STEER_WORKSPACE_ROOT: '' })).toBe('/')
    expect(resolveWorkspaceRoot({ STEER_WORKSPACE_ROOT: '   ' })).toBe('/')
  })

  it('uses root for real process calls by default', () => {
    expect(resolveWorkspaceRoot({})).toBe('/')
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

  it('ignores a workdir the daemon does not have, running at the root instead', () => {
    expect(resolveSessionWorkspace('/sandbox', '/Users/me/proj')).toBe('/sandbox')
    expect(resolveSessionWorkspace('/home/me', '/etc')).toBe('/home/me')
  })

  it('normalizes and accepts the root itself as a workdir', () => {
    expect(resolveSessionWorkspace('/dev', '/dev')).toBe('/dev')
    expect(resolveSessionWorkspace('/dev', '/dev/projectA/../projectB')).toBe('/dev/projectB')
  })
})
