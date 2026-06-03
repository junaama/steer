import { describe, it, expect } from 'vitest'
import { filterSessions, type SessionView } from './filter.js'

const s = (id: string, title: string, lastStatus: SessionView['lastStatus']): SessionView => ({
  id,
  title,
  lastStatus,
  model: 'sonnet',
  updatedAt: 0,
})

const list: SessionView[] = [
  s('1', 'Add auth', 'running'),
  s('2', 'Fix checkout', 'completed'),
  s('3', 'Deploy v2', 'interrupted'),
  s('4', 'Spike index', 'error'),
  s('5', 'Boot agent', 'starting'),
]

describe('filterSessions', () => {
  it('narrows by title query (case-insensitive)', () => {
    expect(filterSessions(list, 'auth', 'all').map((x) => x.id)).toEqual(['1'])
    expect(filterSessions(list, 'FIX', 'all').map((x) => x.id)).toEqual(['2'])
  })

  it('treats running filter as live (running/starting/awaiting-approval)', () => {
    expect(filterSessions(list, '', 'running').map((x) => x.id).sort()).toEqual(['1', '5'])
  })

  it('matches exact status for other filters', () => {
    expect(filterSessions(list, '', 'completed').map((x) => x.id)).toEqual(['2'])
    expect(filterSessions(list, '', 'error').map((x) => x.id)).toEqual(['4'])
  })

  it('combines query and filter', () => {
    expect(filterSessions(list, 'add', 'running').map((x) => x.id)).toEqual(['1'])
    expect(filterSessions(list, 'add', 'completed')).toHaveLength(0)
  })
})
