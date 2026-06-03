export type GetToken = () => Promise<string | null>
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Wrap fetch so every API/sync request carries a fresh WorkOS bearer token. The
 * token is fetched per-request (the AuthKit SDK refreshes it near expiry).
 */
export function createAuthedFetch(getToken: GetToken, fetchImpl: FetchLike): FetchLike {
  return async (url, init = {}) => {
    const token = await getToken()
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetchImpl(url, { ...init, headers })
  }
}

/**
 * Sign out, then force a full reload so all Electric-synced rows are flushed
 * from memory (closes the stale-cross-user-data leak).
 */
export async function performLogout(
  signOut: (opts?: { returnTo?: string }) => Promise<void> | void,
  reload: () => void,
  returnTo?: string,
): Promise<void> {
  await signOut(returnTo ? { returnTo } : undefined)
  reload()
}
