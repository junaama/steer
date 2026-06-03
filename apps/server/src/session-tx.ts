import { sql, eq, and } from 'drizzle-orm'
import { sessions } from '@steer/schema'
import type { Db } from './db.js'

/** The transaction handle the `db.transaction(tx => …)` callback receives. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Authorization/validation failure surfaced with an HTTP status. */
export class WriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Whether `userId` owns `sessionId`. Works on a db handle or a transaction. */
export async function ownsSession(ex: Db | Tx, userId: string, sessionId: string): Promise<boolean> {
  const rows = await ex
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
  return rows.length > 0
}

/** Throw a 403 unless `userId` owns `sessionId`. Call inside the write's tx. */
export async function assertOwns(tx: Tx, userId: string, sessionId: string): Promise<void> {
  if (!(await ownsSession(tx, userId, sessionId))) throw new WriteError(403, 'forbidden: not your session')
}

/**
 * The current transaction's xid. Must run INSIDE the same tx as the write so it
 * matches the row's xid in the Electric stream (the client's awaitTxId
 * reconciliation blocks until that exact xid reappears).
 */
export async function captureTxid(tx: Tx): Promise<string> {
  const res = await tx.execute(sql`select pg_current_xact_id()::text as txid`)
  return (res.rows[0] as { txid: string }).txid
}
