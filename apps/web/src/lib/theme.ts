/**
 * Theme persistence.
 *
 * The chosen theme is stored in localStorage so it survives a refresh — the app
 * used to re-initialise to dark on every load, forcing the user to re-toggle.
 * On first load (nothing stored) we honour the OS `prefers-color-scheme`, then
 * fall back to dark. A matching boot script in index.html applies the same
 * decision before React mounts, so there is no flash of the wrong theme.
 */

const THEME_KEY = 'steer_theme'

export type Theme = 'dark' | 'light'

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

/** The persisted theme, or null if none is saved / storage is unavailable. */
export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return isTheme(value) ? value : null
  } catch {
    return null
  }
}

/** Persist the chosen theme (best-effort; private-mode storage errors are ignored). */
export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // private mode / disabled storage — the preference simply won't persist
  }
}

/** Whether the OS currently prefers a light color scheme. */
function prefersLight(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

/**
 * The theme to start in: a saved preference wins; otherwise the OS color
 * scheme; otherwise dark.
 */
export function initialTheme(): Theme {
  return readStoredTheme() ?? (prefersLight() ? 'light' : 'dark')
}
