import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Icon } from './Icon.js'

describe('Icon', () => {
  it('renders a known glyph', () => {
    const { container } = render(<Icon name="search" />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
  it('renders every icon used by the coding-agent tool map without falling back to dot', () => {
    for (const name of ['edit', 'terminal', 'check', 'swap', 'search', 'grep', 'globe']) {
      const { container, unmount } = render(<Icon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg).toBeInTheDocument()
      expect(svg?.querySelector('circle[cx="12"][cy="12"][r="3"]')).not.toBeInTheDocument()
      unmount()
    }
  })
  it('falls back to the dot glyph for an unknown name', () => {
    const { container } = render(<Icon name="totally-unknown" size={20} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg?.querySelector('circle')).toBeInTheDocument() // dot is a <circle>
  })
})
