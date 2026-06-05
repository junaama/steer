import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialTheme, readStoredTheme, storeTheme } from './theme'

const THEME_KEY = 'steer_theme'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Stub window.matchMedia to report whether the OS prefers light. */
function stubMatchMedia(prefersLight: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: prefersLight && query.includes('light'), media: query }),
  )
}

describe('readStoredTheme', () => {
  it('returns the saved light theme', () => {
    localStorage.setItem(THEME_KEY, 'light')
    expect(readStoredTheme()).toBe('light')
  })

  it('returns the saved dark theme', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    expect(readStoredTheme()).toBe('dark')
  })

  it('returns null for an unrecognised stored value', () => {
    localStorage.setItem(THEME_KEY, 'sepia')
    expect(readStoredTheme()).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    expect(readStoredTheme()).toBeNull()
  })

  it('returns null when storage access throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readStoredTheme()).toBeNull()
  })
})

describe('storeTheme', () => {
  it('persists the theme so a later read returns it', () => {
    storeTheme('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(readStoredTheme()).toBe('light')
  })

  it('swallows storage errors (private mode) without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => storeTheme('dark')).not.toThrow()
  })
})

describe('initialTheme', () => {
  it('uses the saved preference when present, ignoring the OS scheme', () => {
    localStorage.setItem(THEME_KEY, 'light')
    stubMatchMedia(false) // OS prefers dark — saved preference must still win
    expect(initialTheme()).toBe('light')
  })

  it('falls back to the OS light preference when nothing is saved', () => {
    stubMatchMedia(true)
    expect(initialTheme()).toBe('light')
  })

  it('falls back to dark when nothing is saved and the OS prefers dark', () => {
    stubMatchMedia(false)
    expect(initialTheme()).toBe('dark')
  })

  it('falls back to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(initialTheme()).toBe('dark')
  })

  it('falls back to dark when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('boom')
    })
    expect(initialTheme()).toBe('dark')
  })
})
