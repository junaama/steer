import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { saveCredentials, loadCredentials, clearCredentials, configDir, configPath } from './config.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'steer-cfg-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('credentials store', () => {
  it('saves and loads a round-trip', async () => {
    const creds = { serverUrl: 'http://localhost:8080', token: 'tok', email: 'a@b.c' }
    await saveCredentials(creds, home)
    expect(await loadCredentials(home)).toEqual(creds)
  })

  it('writes the file with owner-only (0600) permissions', async () => {
    await saveCredentials({ serverUrl: 's', token: 't', email: 'e' }, home)
    expect((await stat(configPath(home))).mode & 0o777).toBe(0o600)
  })

  it('returns null when no credentials file exists', async () => {
    expect(await loadCredentials(home)).toBeNull()
  })

  it('returns null when the file is missing a token', async () => {
    await mkdir(configDir(home), { recursive: true })
    await writeFile(configPath(home), '{"serverUrl":"s"}')
    expect(await loadCredentials(home)).toBeNull()
  })

  it('defaults email to empty when absent but token present', async () => {
    await mkdir(configDir(home), { recursive: true })
    await writeFile(configPath(home), '{"serverUrl":"s","token":"t"}')
    expect((await loadCredentials(home))?.email).toBe('')
  })

  it('clears credentials (and is idempotent)', async () => {
    await saveCredentials({ serverUrl: 's', token: 't', email: 'e' }, home)
    await clearCredentials(home)
    expect(await loadCredentials(home)).toBeNull()
    await clearCredentials(home)
  })

  it('configDir defaults to the OS home directory', () => {
    expect(configDir()).toBe(join(homedir(), '.steer'))
  })
})
