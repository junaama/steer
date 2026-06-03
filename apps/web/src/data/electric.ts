import { createCollection } from '@tanstack/react-db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import type { SessionRow } from './types.js'
import type { WriteClient } from '../lib/write-client.js'
import type { FetchLike } from '../auth/authed-fetch.js'

// External-SDK boundary: wires TanStack DB's Electric collections to the server's
// auth proxy (reads) and write API (optimistic writes reconciled via txid).
// Rows are typed loosely here (the SDK needs an index-signature row) and cast to
// the strict app types at the edge. Verified end-to-end by the two-window demo (U13).

type GenericRow = Record<string, unknown>

interface Deps {
  serverUrl: string
  authedFetch: FetchLike
  write: WriteClient
}

function shapeUrl(serverUrl: string, collection: string): string {
  return `${serverUrl}/sync/${collection}`
}

export function createSessionsCollection(deps: Deps) {
  const fetchClient = deps.authedFetch as unknown as typeof fetch
  return createCollection(
    electricCollectionOptions<GenericRow>({
      id: 'sessions',
      shapeOptions: { url: shapeUrl(deps.serverUrl, 'sessions'), fetchClient },
      getKey: (row) => row.id as string,
      onInsert: async ({ transaction }) => {
        const row = transaction.mutations[0]!.modified as unknown as SessionRow
        const txid = await deps.write.createSession({
          id: row.id,
          title: row.title,
          task: row.task ?? undefined,
          model: row.model,
        })
        return { txid: Number(txid) }
      },
      onUpdate: async ({ transaction }) => {
        const row = transaction.mutations[0]!.modified as unknown as SessionRow
        const txid = await deps.write.renameSession(row.id, row.title)
        return { txid: Number(txid) }
      },
      onDelete: async ({ transaction }) => {
        const row = transaction.mutations[0]!.original as unknown as SessionRow
        const txid = await deps.write.deleteSession(row.id)
        return { txid: Number(txid) }
      },
    }),
  )
}

export function createEventsCollection(deps: Deps, sessionId: string) {
  const fetchClient = deps.authedFetch as unknown as typeof fetch
  return createCollection(
    electricCollectionOptions<GenericRow>({
      id: `events:${sessionId}`,
      shapeOptions: {
        url: `${shapeUrl(deps.serverUrl, 'events')}?session_id=${encodeURIComponent(sessionId)}`,
        fetchClient,
      },
      getKey: (row) => `${String(row.sessionId)}:${String(row.seq)}`,
    }),
  )
}
