import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@electric-sql/client'
import {
  runnableFromMessages,
  subscribeRunnable,
  type SessionIntent,
  type ShapeSubscriber,
} from './intake.js'

function change(operation: 'insert' | 'update' | 'delete', value: Record<string, unknown>): Message {
  return { key: `sessions/${String(value.id ?? 'x')}`, value, headers: { operation } } as unknown as Message
}
const upToDate = (): Message => ({ headers: { control: 'up-to-date' } }) as unknown as Message

describe('runnableFromMessages', () => {
  it('includes a fresh starting session with its model and task', () => {
    const out = runnableFromMessages([
      change('insert', { id: 's1', last_status: 'starting', model: 'opus', task: 'do the thing' }),
    ])
    expect(out).toEqual([{ id: 's1', model: 'opus', task: 'do the thing' }])
  })

  it('includes a running session (crash-only resume from the reconnect snapshot)', () => {
    const out = runnableFromMessages([
      change('update', { id: 's2', last_status: 'running', model: 'sonnet', task: null }),
    ])
    expect(out).toEqual([{ id: 's2', model: 'sonnet', task: null }])
  })

  it('defaults model to sonnet and task to null when absent or non-string', () => {
    expect(runnableFromMessages([change('insert', { id: 's3', last_status: 'starting' })])).toEqual([
      { id: 's3', model: 'sonnet', task: null },
    ])
  })

  it('excludes terminal/idle statuses and rows with no status', () => {
    const out = runnableFromMessages([
      change('insert', { id: 'a', last_status: 'completed' }),
      change('update', { id: 'b', last_status: 'idle' }),
      change('update', { id: 'c', last_status: 'interrupted' }),
      change('update', { id: 'd', last_status: 'error' }),
      change('insert', { id: 'e' }), // no last_status at all
    ])
    expect(out).toEqual([])
  })

  it('excludes deletes (shape move-out) even when the row is otherwise runnable', () => {
    expect(runnableFromMessages([change('delete', { id: 'x', last_status: 'starting' })])).toEqual([])
  })

  it('excludes control messages (up-to-date / must-refetch)', () => {
    expect(runnableFromMessages([upToDate()])).toEqual([])
  })

  it('skips rows without a valid string id', () => {
    expect(runnableFromMessages([change('insert', { last_status: 'starting' })])).toEqual([])
  })

  it('projects only the runnable rows from a mixed batch, in order', () => {
    const out = runnableFromMessages([
      upToDate(),
      change('insert', { id: 's1', last_status: 'starting', model: 'opus' }),
      change('update', { id: 's1', last_status: 'completed' }),
      change('insert', { id: 's2', last_status: 'running' }),
    ])
    expect(out.map((s) => s.id)).toEqual(['s1', 's2'])
  })
})

describe('subscribeRunnable', () => {
  it('routes each runnable row to onSession and returns the stream unsubscribe fn', () => {
    let captured: ((messages: Message[]) => void) | null = null
    const unsub = vi.fn()
    const stream: ShapeSubscriber = {
      subscribe: (cb) => {
        captured = cb
        return unsub
      },
    }
    const seen: SessionIntent[] = []
    const ret = subscribeRunnable(stream, (intent) => seen.push(intent))

    expect(ret).toBe(unsub)
    captured!([
      change('insert', { id: 's1', last_status: 'starting', model: 'opus', task: 't' }),
      change('insert', { id: 'x', last_status: 'completed' }),
    ])
    expect(seen).toEqual([{ id: 's1', model: 'opus', task: 't' }])
  })

  it('forwards the onError handler to the underlying stream', () => {
    const onError = vi.fn()
    let capturedErr: unknown
    const stream: ShapeSubscriber = {
      subscribe: (_cb, err) => {
        capturedErr = err
        return () => {}
      },
    }
    subscribeRunnable(stream, () => {}, onError)
    expect(capturedErr).toBe(onError)
  })
})
