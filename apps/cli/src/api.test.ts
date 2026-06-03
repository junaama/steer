import { describe, it, expect, vi } from 'vitest'
import { SteerClient, SteerError } from './api.js'

function res(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, { status })
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)))
}

function mk(f: ReturnType<typeof makeFetch>): SteerClient {
  return new SteerClient({ serverUrl: 'http://s', fetchImpl: f as unknown as typeof fetch })
}

describe('SteerClient', () => {
  it('signup posts JSON credentials and returns the token', async () => {
    const f = makeFetch(() => res(201, { token: 't', user: { id: 'u', email: 'a@b.c' } }))
    const out = await mk(f).signup('a@b.c', 'password1')
    expect(out.token).toBe('t')
    expect(f.mock.calls[0]![0]).toBe('http://s/auth/signup')
    const init = f.mock.calls[0]![1]!
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.c', password: 'password1' })
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('maps a 401 to a SteerError carrying the server message', async () => {
    const f = makeFetch(() => res(401, { error: 'invalid email or password' }))
    await expect(mk(f).login('a@b.c', 'x')).rejects.toBeInstanceOf(SteerError)
    await expect(mk(f).login('a@b.c', 'x')).rejects.toMatchObject({ status: 401, message: 'invalid email or password' })
  })

  it('falls back to raw text when the error body is not JSON', async () => {
    const f = makeFetch(() => res(500, 'boom'))
    await expect(mk(f).login('a@b.c', 'x')).rejects.toMatchObject({ status: 500, message: 'boom' })
  })

  it('uses a generic message when the error body is empty', async () => {
    const f = makeFetch(() => res(503, ''))
    await expect(mk(f).login('a@b.c', 'x')).rejects.toMatchObject({ status: 503, message: 'request failed (503)' })
  })

  it('createSession sends the writes envelope with a bearer token', async () => {
    const f = makeFetch(() => res(200, { txid: '42' }))
    const out = await mk(f).createSession('tok', { id: 's1', title: 'T', task: 'do', model: 'sonnet' })
    expect(out.txid).toBe('42')
    expect(f.mock.calls[0]![0]).toBe('http://s/writes')
    const init = f.mock.calls[0]![1]!
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({
      collection: 'sessions',
      op: 'insert',
      payload: { id: 's1', title: 'T', task: 'do', model: 'sonnet' },
    })
  })

  it('sendMessage posts the follow-up to /sessions/:id/message', async () => {
    const f = makeFetch(() => res(200, { txid: '7' }))
    const out = await mk(f).sendMessage('tok', 'sess a', 'add tests')
    expect(out.txid).toBe('7')
    expect(f.mock.calls[0]![0]).toBe('http://s/sessions/sess%20a/message')
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ text: 'add tests' })
  })

  it('logout resolves to void on an empty 204', async () => {
    const f = makeFetch(() => new Response(null, { status: 204 }))
    await expect(mk(f).logout('tok')).resolves.toBeUndefined()
  })

  it('me reads /auth/me with the token', async () => {
    const f = makeFetch(() => res(200, { user: { id: 'u', email: 'a@b.c' } }))
    expect((await mk(f).me('tok')).user.email).toBe('a@b.c')
    expect(new Headers(f.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer tok')
  })

  it('shape builds the events query with session_id, sessions without', async () => {
    const f = makeFetch(() => res(200, []))
    const c = mk(f)
    await c.shape('tok', 'events', 'sess 1')
    await c.shape('tok', 'sessions')
    expect(f.mock.calls[0]![0]).toBe('http://s/sync/events?session_id=sess%201')
    expect(f.mock.calls[1]![0]).toBe('http://s/sync/sessions')
  })
})
