import { describe, it, expect, vi } from 'vitest'
import { createRunner } from './daemon.js'
import type { AgentStore } from './store.js'
import type { SessionIntent } from './intake.js'
import type { Db } from './db.js'

const intent = (id: string): SessionIntent => ({ id, model: 'sonnet', task: null })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const noDb = {} as Db // unused — the store is injected

function fakeStore(over: Partial<AgentStore> = {}): AgentStore {
  return {
    listEvents: vi.fn(async () => []),
    appendEvent: vi.fn(async () => 0),
    setStatus: vi.fn(async () => {}),
    listUnconsumedControls: vi.fn(async () => []),
    consumeControl: vi.fn(async () => {}),
    claimSession: vi.fn(async () => true),
    ...over,
  }
}

describe('createRunner — claim gate', () => {
  it('runs the session when the claim is won, then clears the active guard', async () => {
    const store = fakeStore({ claimSession: vi.fn(async () => true) })
    const runOne = vi.fn(async () => {})
    const active = new Set<string>()
    createRunner(noDb, active, 'laptop', { store, runOne })(intent('s1'))
    await tick()
    expect(store.claimSession).toHaveBeenCalledWith('s1', 'laptop')
    expect(runOne).toHaveBeenCalledOnce()
    expect(active.has('s1')).toBe(false)
  })

  it('does NOT run when the claim is lost (another daemon owns it)', async () => {
    const store = fakeStore({ claimSession: vi.fn(async () => false) })
    const runOne = vi.fn(async () => {})
    const active = new Set<string>()
    createRunner(noDb, active, 'laptop', { store, runOne })(intent('s1'))
    await tick()
    expect(runOne).not.toHaveBeenCalled()
    expect(active.has('s1')).toBe(false)
  })

  it('is a no-op when the session is already active in this process', async () => {
    const store = fakeStore()
    const runOne = vi.fn(async () => {})
    const active = new Set<string>(['s1'])
    createRunner(noDb, active, 'laptop', { store, runOne })(intent('s1'))
    await tick()
    expect(store.claimSession).not.toHaveBeenCalled()
    expect(runOne).not.toHaveBeenCalled()
  })

  it('skips without erroring the session when the claim itself throws, but logs the cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setStatus = vi.fn(async () => {})
    const store = fakeStore({
      claimSession: vi.fn(async () => {
        throw new Error('db blip')
      }),
      setStatus,
    })
    const runOne = vi.fn(async () => {})
    const active = new Set<string>()
    createRunner(noDb, active, 'laptop', { store, runOne })(intent('s1'))
    await tick()
    expect(runOne).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled() // never errors a session it may not own
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claim failed for s1: db blip'))
    expect(active.has('s1')).toBe(false)
    warn.mockRestore()
  })

  it('marks the session errored when the run throws AND logs the cause (no more silent error)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setStatus = vi.fn(async () => {})
    const cause = new Error('boom')
    const store = fakeStore({ claimSession: vi.fn(async () => true), setStatus })
    const runOne = vi.fn(async () => {
      throw cause
    })
    const active = new Set<string>()
    createRunner(noDb, active, 'laptop', { store, runOne })(intent('s1'))
    await tick()
    expect(setStatus).toHaveBeenCalledWith('s1', 'error')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('session s1 failed: boom'), cause)
    expect(active.has('s1')).toBe(false)
    error.mockRestore()
  })
})
