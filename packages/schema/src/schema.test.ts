import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { environments } from './schema.js'

describe('environments table', () => {
  it('has the expected columns', () => {
    const cols = Object.keys(getTableColumns(environments))
    expect(cols).toContain('id')
    expect(cols).toContain('env')
    expect(cols).toContain('host')
    expect(cols).toContain('lastSeenAt')
    expect(cols).toContain('createdAt')
  })

  it('does not have a kind column', () => {
    const cols = Object.keys(getTableColumns(environments))
    expect(cols).not.toContain('kind')
  })

  it('has exactly five columns', () => {
    const cols = Object.keys(getTableColumns(environments))
    expect(cols).toHaveLength(5)
  })
})
