import { describe, it, expect, vi } from 'vitest'
import { createWriteClient } from './write-client.js'

function okFetch(txid = '42') {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ txid }), { status: 200 }))
}

describe('createWriteClient', () => {
  it('posts a session insert and returns the txid', async () => {
    const fetchImpl = okFetch('100')
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    const txid = await client.createSession({ id: 's1', title: 'Add auth', task: 'do it' })
    expect(txid).toBe('100')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://s/writes')
    expect(JSON.parse(init!.body as string)).toEqual({
      collection: 'sessions',
      op: 'insert',
      payload: { id: 's1', title: 'Add auth', task: 'do it' },
    })
  })

  it('builds rename / delete / control payloads', async () => {
    const fetchImpl = okFetch()
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    await client.renameSession('s1', 'New title')
    await client.setStatus('s1', 'starting')
    await client.deleteSession('s1')
    await client.sendControl('s1', 'interrupt', {})
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(c[1]!.body as string))
    expect(bodies[0]).toEqual({ collection: 'sessions', op: 'update', payload: { id: 's1', title: 'New title' } })
    expect(bodies[1]).toEqual({ collection: 'sessions', op: 'update', payload: { id: 's1', lastStatus: 'starting' } })
    expect(bodies[2]).toEqual({ collection: 'sessions', op: 'delete', payload: { id: 's1' } })
    expect(bodies[3]).toEqual({ collection: 'controls', op: 'insert', payload: { sessionId: 's1', type: 'interrupt', payload: {} } })
  })

  it('includes environment and workdir in createSession when provided', async () => {
    const fetchImpl = okFetch('200')
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    await client.createSession({ id: 's2', title: 'Routed', environment: 'laptop', workdir: '/home/user/project' })
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    expect(body.payload).toEqual({ id: 's2', title: 'Routed', environment: 'laptop', workdir: '/home/user/project' })
  })

  it('omits environment and workdir from createSession when undefined', async () => {
    const fetchImpl = okFetch('201')
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    await client.createSession({ id: 's3', title: 'Unrouted' })
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    expect(body.payload).toEqual({ id: 's3', title: 'Unrouted' })
    // JSON.stringify drops undefined, so environment/workdir are absent
    expect('environment' in body.payload).toBe(false)
    expect('workdir' in body.payload).toBe(false)
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }))
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    await expect(client.deleteSession('s1')).rejects.toThrow(/403/)
  })

  it('sendMessage POSTs to /sessions/:id/message and returns txid', async () => {
    const fetchImpl = okFetch('55')
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    const txid = await client.sendMessage('sess-42', 'now add tests')
    expect(txid).toBe('55')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://s/sessions/sess-42/message')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({ text: 'now add tests' })
  })

  it('sendMessage throws on non-OK response', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }))
    const client = createWriteClient({ serverUrl: 'http://s', fetchImpl })
    await expect(client.sendMessage('sess-42', 'hello')).rejects.toThrow(/403/)
  })
})
