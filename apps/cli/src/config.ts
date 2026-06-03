import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'

/** Persisted login state — written to ~/.steer/credentials.json (0600). */
export interface Credentials {
  serverUrl: string
  token: string
  email: string
}

export function configDir(home: string = homedir()): string {
  return join(home, '.steer')
}

export function configPath(home?: string): string {
  return join(configDir(home), 'credentials.json')
}

/** Write credentials with owner-only permissions (it holds a session token). */
export async function saveCredentials(creds: Credentials, home?: string): Promise<void> {
  await mkdir(configDir(home), { recursive: true })
  const file = configPath(home)
  await writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 })
  await chmod(file, 0o600)
}

export async function loadCredentials(home?: string): Promise<Credentials | null> {
  try {
    const raw = await readFile(configPath(home), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Credentials>
    if (!parsed.token || !parsed.serverUrl) return null
    return { serverUrl: parsed.serverUrl, token: parsed.token, email: parsed.email ?? '' }
  } catch {
    return null
  }
}

export async function clearCredentials(home?: string): Promise<void> {
  await rm(configPath(home), { force: true })
}
