import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewSessionModal } from './NewSessionModal.js'
import { ConfirmModal } from './ConfirmModal.js'

describe('NewSessionModal', () => {
  it('disables start until a task is entered, then creates with the chosen model', () => {
    const onCreate = vi.fn()
    const onClose = vi.fn()
    render(<NewSessionModal onClose={onClose} onCreate={onCreate} environments={[]} />)
    const start = screen.getByText('Start session')
    expect(start).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByText('opus'))
    fireEvent.click(start)
    expect(onCreate).toHaveBeenCalledWith({ task: 'do the thing', model: 'opus', environment: undefined, workdir: '/', image: undefined })
  })

  it('closes on cancel and on scrim mousedown but not on modal mousedown', () => {
    const onClose = vi.fn()
    const { container } = render(<NewSessionModal onClose={onClose} onCreate={vi.fn()} environments={[]} />)
    fireEvent.mouseDown(container.querySelector('.modal')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(container.querySelector('.scrim')!)
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('ConfirmModal', () => {
  it('renders title/message and wires keep + confirm', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<ConfirmModal title="Delete session?" message="gone forever" onClose={onClose} onConfirm={onConfirm} />)
    expect(screen.getByText('Delete session?')).toBeInTheDocument()
    expect(screen.getByText('gone forever')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Keep'))
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('closes on scrim mousedown but not modal mousedown', () => {
    const onClose = vi.fn()
    const { container } = render(<ConfirmModal title="t" message="m" onClose={onClose} onConfirm={vi.fn()} />)
    fireEvent.mouseDown(container.querySelector('.modal')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(container.querySelector('.scrim')!)
    expect(onClose).toHaveBeenCalled()
  })
})
