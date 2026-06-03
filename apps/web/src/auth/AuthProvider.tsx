import type { ReactNode } from 'react'
import { AuthKitProvider, useAuth } from '@workos-inc/authkit-react'

const CLIENT_ID = import.meta.env.VITE_WORKOS_CLIENT_ID ?? ''
const REDIRECT_URI = import.meta.env.VITE_WORKOS_REDIRECT_URI ?? `${location.origin}/callback`

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <AuthKitProvider clientId={CLIENT_ID} redirectUri={REDIRECT_URI}>
      {children}
    </AuthKitProvider>
  )
}

export interface SteerAuth {
  isLoading: boolean
  isAuthed: boolean
  email: string
  getToken: () => Promise<string | null>
  signIn: () => void
  signOut: (opts?: { returnTo?: string }) => Promise<void> | void
}

/** Adapt AuthKit's context to the small surface the app needs. */
export function useSteerAuth(): SteerAuth {
  const auth = useAuth()
  return {
    isLoading: auth.isLoading,
    isAuthed: auth.user !== null,
    email: auth.user?.email ?? '',
    getToken: async () => {
      try {
        return await auth.getAccessToken()
      } catch {
        return null
      }
    },
    signIn: () => void auth.signIn(),
    signOut: auth.signOut,
  }
}
