import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Shell } from './Shell.js'

describe('Shell', () => {
  it('renders wordmark, user, sidebar and main; wires theme + logout', () => {
    const onToggleTheme = vi.fn()
    const onLogout = vi.fn()
    render(
      <Shell
        userEmail="arjun@acme.dev"
        theme="dark"
        onToggleTheme={onToggleTheme}
        onLogout={onLogout}
        sidebar={<div>SIDEBAR</div>}
        main={<div>MAIN</div>}
      />,
    )
    expect(screen.getByText('steer')).toBeInTheDocument()
    expect(screen.getByText('arjun@acme.dev')).toBeInTheDocument()
    expect(screen.getByText('AR')).toBeInTheDocument() // initials
    expect(screen.getByText('SIDEBAR')).toBeInTheDocument()
    expect(screen.getByText('MAIN')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Toggle theme'))
    expect(onToggleTheme).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Logout'))
    expect(onLogout).toHaveBeenCalled()
  })

  it('shows the moon icon in light theme', () => {
    render(
      <Shell userEmail="a@b.c" theme="light" onToggleTheme={vi.fn()} onLogout={vi.fn()} sidebar={null} main={null} />,
    )
    expect(screen.getByLabelText('Toggle theme')).toBeInTheDocument()
  })
})
