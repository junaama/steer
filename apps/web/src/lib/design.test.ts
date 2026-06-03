import { describe, it, expect } from 'vitest'
import { SESSION_STATUSES, TOOL_STATUSES } from '@steer/schema'
import { SESSION_STATUS_META, TOOL_STATUS_META, toolIcon, relTime } from './design.js'

describe('status meta', () => {
  it('has a label + color for every session status', () => {
    for (const s of SESSION_STATUSES) {
      expect(SESSION_STATUS_META[s].color).toMatch(/^var\(--/)
      expect(SESSION_STATUS_META[s].label.length).toBeGreaterThan(0)
    }
  })
  it('has a label + color for every tool status', () => {
    for (const s of TOOL_STATUSES) {
      expect(TOOL_STATUS_META[s].color).toMatch(/^var\(--/)
      expect(TOOL_STATUS_META[s].label.length).toBeGreaterThan(0)
    }
  })
})

describe('toolIcon', () => {
  it('maps known tools', () => {
    expect(toolIcon('read_file')).toBe('read')
    expect(toolIcon('grep')).toBe('grep')
    expect(toolIcon('write_file')).toBe('file')
  })
  it('falls back to wrench for unknown tools', () => {
    expect(toolIcon('mystery')).toBe('wrench')
  })
})

describe('relTime', () => {
  const now = 1_000_000_000_000
  it('formats seconds / minutes / hours / days', () => {
    expect(relTime(now - 5_000, now)).toBe('5s ago')
    expect(relTime(now - 120_000, now)).toBe('2m ago')
    expect(relTime(now - 3 * 3600_000, now)).toBe('3h ago')
    expect(relTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})
