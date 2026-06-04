import type { ControlType, SessionStatus } from '@steer/schema'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface WriteResponse {
  txid: string
}

/**
 * Client for the server's generic write endpoint. Every write returns the
 * Postgres txid so the optimistic TanStack DB collection can reconcile against
 * the exact transaction once it streams back through Electric (awaitTxId).
 */
export function createWriteClient(opts: { serverUrl: string; fetchImpl: FetchLike }) {
  async function write(
    collection: 'sessions' | 'controls',
    op: 'insert' | 'update' | 'delete',
    payload: Record<string, unknown>,
  ): Promise<string> {
    const res = await opts.fetchImpl(`${opts.serverUrl}/writes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection, op, payload }),
    })
    if (!res.ok) throw new Error(`write failed: ${res.status}`)
    const body = (await res.json()) as WriteResponse
    return body.txid
  }

  return {
    createSession: (s: { id: string; title: string; task?: string; model?: string; environment?: string; workdir?: string }) =>
      write('sessions', 'insert', s),
    renameSession: (id: string, title: string) => write('sessions', 'update', { id, title }),
    setStatus: (id: string, lastStatus: SessionStatus) => write('sessions', 'update', { id, lastStatus }),
    deleteSession: (id: string) => write('sessions', 'delete', { id }),
    sendControl: (sessionId: string, type: ControlType, payload: Record<string, unknown>) =>
      write('controls', 'insert', { sessionId, type, payload }),
  }
}

export type WriteClient = ReturnType<typeof createWriteClient>
