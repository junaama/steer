import { describe, it, expect, vi, afterEach } from 'vitest'
import { MAX_IMAGE_BASE64_BYTES } from '@steer/schema'
import {
  parseDataUrl,
  toPreviewUrl,
  readImageFile,
  fromBrowserFile,
  type ReadableFile,
} from './image-attach.js'

const fakeFile = (type: string, dataUrl: string | (() => Promise<string>)): ReadableFile => ({
  type,
  toDataUrl: typeof dataUrl === 'string' ? () => Promise.resolve(dataUrl) : dataUrl,
})

describe('parseDataUrl', () => {
  it('splits a base64 data URL into mediaType + data', () => {
    expect(parseDataUrl('data:image/png;base64,iVBORw0KGgo')).toEqual({
      mediaType: 'image/png',
      dataBase64: 'iVBORw0KGgo',
    })
  })

  it('handles a data URL whose base64 spans newlines (the s flag)', () => {
    expect(parseDataUrl('data:image/png;base64,AAAA\nBBBB')).toEqual({
      mediaType: 'image/png',
      dataBase64: 'AAAA\nBBBB',
    })
  })

  it('returns null for a non-data-URL string', () => {
    expect(parseDataUrl('not a data url')).toBeNull()
  })

  it('returns null for a data URL with empty data', () => {
    expect(parseDataUrl('data:image/png;base64,')).toBeNull()
  })
})

describe('toPreviewUrl', () => {
  it('reassembles a data URL from an attachment', () => {
    expect(toPreviewUrl({ mediaType: 'image/jpeg', dataBase64: 'AAAA' })).toBe('data:image/jpeg;base64,AAAA')
  })
})

describe('readImageFile', () => {
  it('reads a valid image into an attachment', async () => {
    const result = await readImageFile(fakeFile('image/png', 'data:image/png;base64,iVBORw0KGgo'))
    expect(result).toEqual({ ok: true, image: { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo' } })
  })

  it('rejects a non-image file', async () => {
    const result = await readImageFile(fakeFile('application/pdf', 'data:application/pdf;base64,AAAA'))
    expect(result).toEqual({ ok: false, error: 'Only image files can be attached.' })
  })

  it('rejects an over-cap image with a size message', async () => {
    const overCap = 'a'.repeat(MAX_IMAGE_BASE64_BYTES + 1)
    const result = await readImageFile(fakeFile('image/png', `data:image/png;base64,${overCap}`))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('too large')
  })

  it('accepts an image exactly at the cap', async () => {
    const atCap = 'a'.repeat(MAX_IMAGE_BASE64_BYTES)
    const result = await readImageFile(fakeFile('image/png', `data:image/png;base64,${atCap}`))
    expect(result.ok).toBe(true)
  })

  it('reports a clear error when the reader yields a malformed data URL', async () => {
    const result = await readImageFile(fakeFile('image/png', 'garbage-not-a-data-url'))
    expect(result).toEqual({ ok: false, error: 'Could not read the image file.' })
  })

  it('reports a clear error when reading the file throws', async () => {
    const result = await readImageFile(fakeFile('image/png', () => Promise.reject(new Error('boom'))))
    expect(result).toEqual({ ok: false, error: 'Could not read the image file.' })
  })
})

describe('fromBrowserFile', () => {
  const realFileReader = globalThis.FileReader
  afterEach(() => {
    globalThis.FileReader = realFileReader
  })

  it('resolves the data URL on a successful FileReader load', async () => {
    class FakeReader {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.result = 'data:image/png;base64,iVBORw0KGgo'
        this.onload?.()
      }
    }
    globalThis.FileReader = FakeReader as unknown as typeof FileReader
    const readable = fromBrowserFile({ type: 'image/png' } as File)
    expect(readable.type).toBe('image/png')
    await expect(readable.toDataUrl()).resolves.toBe('data:image/png;base64,iVBORw0KGgo')
  })

  it('defaults a null FileReader result to an empty string', async () => {
    class FakeReader {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.onload?.()
      }
    }
    globalThis.FileReader = FakeReader as unknown as typeof FileReader
    await expect(fromBrowserFile({ type: 'image/png' } as File).toDataUrl()).resolves.toBe('')
  })

  it('rejects when the FileReader errors', async () => {
    class FakeReader {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.onerror?.()
      }
    }
    globalThis.FileReader = FakeReader as unknown as typeof FileReader
    await expect(fromBrowserFile({ type: 'image/png' } as File).toDataUrl()).rejects.toThrow('read failed')
  })
})
