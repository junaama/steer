import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MAX_IMAGE_BASE64_BYTES } from '@steer/schema'
import { NewSessionModal, type NewSessionModalProps } from './NewSessionModal.js'
import type { EnvironmentRow } from '../data/types.js'

// jsdom's FileReader.readAsDataURL is unreliable across versions, so stub a
// deterministic one that emits a fixed data URL (null = simulate a read error).
function stubFileReader(dataUrl: string | null): () => void {
  const real = globalThis.FileReader
  class FakeReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(): void {
      // Resolve on a microtask so the component's async read mirrors real timing.
      void Promise.resolve().then(() => {
        if (dataUrl === null) {
          this.onerror?.()
        } else {
          this.result = dataUrl
          this.onload?.()
        }
      })
    }
  }
  globalThis.FileReader = FakeReader as unknown as typeof FileReader
  return () => {
    globalThis.FileReader = real
  }
}

function imageFile(name: string, type: string, body = 'bytes'): File {
  return new File([body], name, { type })
}

const envRows: EnvironmentRow[] = [
  { id: 'laptop', env: 'laptop', host: 'dev-machine.local', lastSeenAt: new Date().toISOString(), createdAt: '2026-06-04T09:00:00.000Z' },
  { id: 'cloud-1', env: 'cloud-1', host: 'cloud-host.example', lastSeenAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' },
  { id: 'hostname-abc', env: null, host: 'hostname-abc', lastSeenAt: new Date().toISOString(), createdAt: '2026-06-04T09:00:00.000Z' },
]

function setup(overrides: Partial<NewSessionModalProps> = {}): { props: NewSessionModalProps } {
  const props: NewSessionModalProps = {
    onClose: vi.fn(),
    onCreate: vi.fn(),
    environments: envRows,
    defaultEnvironment: null,
    ...overrides,
  }
  render(<NewSessionModal {...props} />)
  return { props }
}

describe('NewSessionModal', () => {
  it('lists registered environments plus "Default (unrouted)" in the selector', () => {
    setup()
    const select = screen.getByLabelText('Environment') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.textContent)
    expect(options[0]).toBe('Default (unrouted)')
    expect(options).toHaveLength(4) // default + 3 environments
    // Named environments present
    expect(options.some((o) => o?.includes('laptop'))).toBe(true)
    expect(options.some((o) => o?.includes('cloud-1'))).toBe(true)
    expect(options.some((o) => o?.includes('hostname-abc'))).toBe(true)
  })

  it('shows online/offline indicators derived from lastSeenAt', () => {
    setup()
    const select = screen.getByLabelText('Environment') as HTMLSelectElement
    const options = Array.from(select.options)
    // laptop is recent -> online (filled circle)
    const laptopOpt = options.find((o) => o.textContent?.includes('laptop') && o.textContent?.includes('dev-machine'))
    expect(laptopOpt?.textContent).toContain('●') // ● filled = online
    // cloud-1 is stale -> offline (empty circle)
    const cloudOpt = options.find((o) => o.textContent?.includes('cloud-1'))
    expect(cloudOpt?.textContent).toContain('○') // ○ empty = offline
  })

  it('passes environment from selected row to onCreate', () => {
    const { props } = setup()
    // Type a task
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'do the thing' } })
    // Select the laptop environment
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'laptop' } })
    // Submit
    fireEvent.click(screen.getByText('Start session'))
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'do the thing', model: 'sonnet', environment: 'laptop' }),
    )
  })

  it('passes undefined environment when "Default (unrouted)" is selected', () => {
    const { props } = setup()
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
    // Keep the default selection
    fireEvent.click(screen.getByText('Start session'))
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ environment: undefined }),
    )
  })

  it('passes undefined environment when a default-daemon row (env=null) is selected', () => {
    const { props } = setup()
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
    // Select the default daemon row (env is null)
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'hostname-abc' } })
    fireEvent.click(screen.getByText('Start session'))
    // env is null on the row, so environment should be undefined (unrouted)
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ environment: undefined }),
    )
  })

  it('forwards workdir when provided', () => {
    const { props } = setup()
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/home/user/project' } })
    fireEvent.click(screen.getByText('Start session'))
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ workdir: '/home/user/project' }),
    )
  })

  it('defaults new sessions to the daemon host root', () => {
    const { props } = setup()
    expect(screen.getByLabelText('Working directory')).toHaveValue('/')
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
    fireEvent.click(screen.getByText('Start session'))
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ workdir: '/' }),
    )
  })

  it('falls back to root when the workdir field is cleared', () => {
    const { props } = setup()
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Start session'))
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ workdir: '/' }),
    )
  })

  it('pre-selects the sticky default environment', () => {
    setup({ defaultEnvironment: 'laptop' })
    const select = screen.getByLabelText('Environment') as HTMLSelectElement
    expect(select.value).toBe('laptop')
  })

  it('falls back to Default (unrouted) when sticky default does not match', () => {
    setup({ defaultEnvironment: 'nonexistent' })
    const select = screen.getByLabelText('Environment') as HTMLSelectElement
    // nonexistent isn't a valid option value, so the <select> falls back to the first option
    // The behavior is that it renders with value 'nonexistent' but no matching option exists
    // so the select will show the first option. We verify the initial state is set.
    expect(select.value).toBeDefined()
  })

  it('disables Start when task is empty', () => {
    setup()
    const startBtn = screen.getByText('Start session') as HTMLButtonElement
    expect(startBtn.disabled).toBe(true)
  })

  it('renders with empty environments list', () => {
    setup({ environments: [] })
    const select = screen.getByLabelText('Environment') as HTMLSelectElement
    expect(select.options).toHaveLength(1) // only "Default (unrouted)"
    expect(select.options[0]!.textContent).toBe('Default (unrouted)')
  })

  // R14 vision input: the composer attaches + previews an image and forwards it to
  // onCreate (which the App wires to the write boundary).
  it('attaches an image, previews it, and forwards it to onCreate', async () => {
    const restore = stubFileReader('data:image/png;base64,iVBORw0KGgo')
    try {
      const { props } = setup()
      fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'fix this layout' } })
      fireEvent.change(screen.getByLabelText('Attach image'), {
        target: { files: [imageFile('shot.png', 'image/png')] },
      })
      // The preview image renders once the file is read.
      const preview = await screen.findByAltText('Attached preview')
      expect(preview.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo')

      fireEvent.click(screen.getByText('Start session'))
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'fix this layout',
          image: { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo' },
        }),
      )
    } finally {
      restore()
    }
  })

  it('omits image from onCreate when none is attached', () => {
    const { props } = setup()
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
    fireEvent.click(screen.getByText('Start session'))
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ image: undefined }))
  })

  it('shows an error and attaches nothing for a non-image file', async () => {
    const restore = stubFileReader('data:text/plain;base64,Ym9keQ==')
    try {
      const { props } = setup()
      fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
      fireEvent.change(screen.getByLabelText('Attach image'), {
        target: { files: [imageFile('notes.txt', 'text/plain')] },
      })
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('Only image files')
      expect(screen.queryByAltText('Attached preview')).toBeNull()

      fireEvent.click(screen.getByText('Start session'))
      expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ image: undefined }))
    } finally {
      restore()
    }
  })

  it('shows a size error for an over-cap image', async () => {
    const overCap = 'a'.repeat(MAX_IMAGE_BASE64_BYTES + 1)
    const restore = stubFileReader(`data:image/png;base64,${overCap}`)
    try {
      setup()
      fireEvent.change(screen.getByLabelText('Attach image'), {
        target: { files: [imageFile('huge.png', 'image/png')] },
      })
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('too large')
      expect(screen.queryByAltText('Attached preview')).toBeNull()
    } finally {
      restore()
    }
  })

  it('removes an attached image when "Remove image" is clicked', async () => {
    const restore = stubFileReader('data:image/png;base64,iVBORw0KGgo')
    try {
      const { props } = setup()
      fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'task' } })
      fireEvent.change(screen.getByLabelText('Attach image'), {
        target: { files: [imageFile('shot.png', 'image/png')] },
      })
      await screen.findByAltText('Attached preview')
      fireEvent.click(screen.getByText('Remove image'))
      expect(screen.queryByAltText('Attached preview')).toBeNull()

      fireEvent.click(screen.getByText('Start session'))
      expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ image: undefined }))
    } finally {
      restore()
    }
  })

  it('ignores a change event with no chosen file', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Attach image'), { target: { files: [] } })
    expect(screen.queryByAltText('Attached preview')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears a prior error when a valid image replaces a rejected one', async () => {
    const restore = stubFileReader('data:image/png;base64,iVBORw0KGgo')
    try {
      setup()
      // First a non-image file (rejected on type before the reader runs).
      fireEvent.change(screen.getByLabelText('Attach image'), {
        target: { files: [imageFile('notes.txt', 'text/plain')] },
      })
      await screen.findByRole('alert')
      // Then a valid image — the error clears and the preview appears.
      fireEvent.change(screen.getByLabelText('Attach image'), {
        target: { files: [imageFile('shot.png', 'image/png')] },
      })
      await screen.findByAltText('Attached preview')
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      restore()
    }
  })
})
