import { describe, it, expect, vi } from 'vitest'
import { createAuthedFetch, performLogout } from './authed-fetch.js'

describe('createAuthedFetch', () => {
  it('attaches a bearer token when present', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
    const authed = createAuthedFetch(async () => 'tok123', fetchImpl)
    await authed('http://s/writes', { method: 'POST' })
    const init = fetchImpl.mock.calls[0]![1]!
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok123')
    expect(init.method).toBe('POST')
  })

  it('omits the header when there is no token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
    const authed = createAuthedFetch(async () => null, fetchImpl)
    await authed('http://s/sync/sessions')
    const init = fetchImpl.mock.calls[0]![1]!
    expect(new Headers(init.headers).get('authorization')).toBeNull()
  })
})

describe('performLogout', () => {
  it('signs out then forces a reload', async () => {
    const order: string[] = []
    const signOut = vi.fn(async () => {
      order.push('signOut')
    })
    const reload = vi.fn(() => order.push('reload'))
    await performLogout(signOut, reload, 'http://app')
    expect(signOut).toHaveBeenCalledWith({ returnTo: 'http://app' })
    expect(order).toEqual(['signOut', 'reload'])
  })

  it('signs out with no options when returnTo is omitted', async () => {
    const signOut = vi.fn(async () => undefined)
    const reload = vi.fn()
    await performLogout(signOut, reload)
    expect(signOut).toHaveBeenCalledWith(undefined)
    expect(reload).toHaveBeenCalled()
  })
})
