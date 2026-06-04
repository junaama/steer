import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { decideRestore, type AuthUser, type MeProbe } from './restore'

/**
 * Self-hosted session auth client. Replaces WorkOS AuthKit: there is no hosted
 * redirect and no SDK — the SPA posts credentials to the server's /auth routes,
 * stores the returned opaque session token, and attaches it as a bearer on
 * every API/sync request. `useSteerAuth` adapts this to the small surface the
 * app consumes, unchanged from before.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080'
const TOKEN_KEY = 'steer_token'

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private-mode / disabled storage: auth simply won't persist across reloads.
  }
}

interface AuthContextValue {
  isLoading: boolean
  user: AuthUser | null
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

async function authenticate(path: '/auth/login' | '/auth/signup', email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? 'Authentication failed')
  }
  return (await res.json()) as { token: string; user: AuthUser }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)

  // On load, restore the persisted token by validating it against /auth/me.
  // Only an explicit 401/403 discards the token; a network error or 5xx (the
  // server is mid-restart during `docker compose up`) keeps it, so a transient
  // outage never logs the user out. See decideRestore for the policy.
  useEffect(() => {
    let cancelled = false
    const token = readToken()
    if (!token) {
      setIsLoading(false)
      return
    }
    const probe = async (): Promise<MeProbe> => {
      try {
        const res = await fetch(`${SERVER_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
        const user = res.ok ? ((await res.json()) as { user: AuthUser }).user : null
        return { ok: true, status: res.status, user }
      } catch {
        return { ok: false }
      }
    }
    void probe().then((result) => {
      if (cancelled) return
      const decision = decideRestore(result)
      if (decision.kind === 'authed') setUser(decision.user)
      else if (decision.kind === 'clear') writeToken(null)
      // 'keep' — leave the token in place; a reload once the server is back
      // restores the session without forcing the user to sign in again.
      setIsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const run = useCallback(
    async (path: '/auth/login' | '/auth/signup', email: string, password: string) => {
      const { token, user: u } = await authenticate(path, email, password)
      writeToken(token)
      setUser(u)
    },
    [],
  )

  const login = useCallback((email: string, password: string) => run('/auth/login', email, password), [run])
  const signup = useCallback((email: string, password: string) => run('/auth/signup', email, password), [run])

  const logout = useCallback(async () => {
    const token = readToken()
    if (token) {
      await fetch(`${SERVER_URL}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    }
    writeToken(null)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ isLoading, user, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useSteerAuth must be used within an AuthProvider')
  return ctx
}

export interface SteerAuth {
  isLoading: boolean
  isAuthed: boolean
  email: string
  getToken: () => Promise<string | null>
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<void>
  signOut: (opts?: { returnTo?: string }) => Promise<void> | void
}

/** Adapt the session context to the small surface the app needs. */
export function useSteerAuth(): SteerAuth {
  const auth = useAuthContext()
  return {
    isLoading: auth.isLoading,
    isAuthed: auth.user !== null,
    email: auth.user?.email ?? '',
    // Read straight from storage so a freshly-issued token is never stale.
    getToken: async () => readToken(),
    login: auth.login,
    signup: auth.signup,
    signOut: () => auth.logout(),
  }
}
