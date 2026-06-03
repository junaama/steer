import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffView } from './DiffView.js'
import { computeDiff } from '../lib/diff.js'

describe('DiffView', () => {
  it('renders context, added and removed lines with the file header', () => {
    render(<DiffView file="src/x.ts" diff={computeDiff('a\nold\nc', 'a\nnew\nc')} />)
    expect(screen.getByText('src/x.ts')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    // context lines render with no +/− sign
    expect(screen.getByText('old')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
    const ctx = screen.getAllByText('a')
    expect(ctx.length).toBeGreaterThan(0)
  })
})
