import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspDiagnostic {
  path: string
  range: LspRange
  severity: 'error' | 'warning' | 'information' | 'hint' | 'unknown'
  message: string
}

export interface LspLocation {
  path: string
  range: LspRange
}

export interface LspClient {
  isEnabled(): boolean
  diagnostics(path: string): Promise<LspDiagnostic[]>
  definition(path: string, line: number, character: number): Promise<LspLocation[]>
  references(path: string, line: number, character: number): Promise<LspLocation[]>
  hover?(path: string, line: number, character: number): Promise<string | null>
}

interface RpcResponse {
  id?: number
  result?: unknown
  error?: { message?: string }
}

interface ServerDiagnostic {
  range?: LspRange
  severity?: number
  message?: string
}

interface PublishDiagnosticsParams {
  uri?: string
  diagnostics?: ServerDiagnostic[]
}

interface JsonRpcNotification {
  method?: string
  params?: unknown
}

const severityNames = new Map<number, LspDiagnostic['severity']>([
  [1, 'error'],
  [2, 'warning'],
  [3, 'information'],
  [4, 'hint'],
])

function disabledClient(): LspClient {
  return {
    isEnabled: () => false,
    diagnostics: async () => [],
    definition: async () => [],
    references: async () => [],
    hover: async () => null,
  }
}

function encodeMessage(payload: unknown): string {
  const body = JSON.stringify(payload)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

function fileUri(path: string): string {
  return pathToFileURL(path).toString()
}

function pathFromUri(uri: string): string {
  return fileURLToPath(uri)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asLocation(item: unknown): LspLocation[] {
  if (isObject(item) && typeof item.uri === 'string' && isObject(item.range)) {
    return [{ path: pathFromUri(item.uri), range: item.range as unknown as LspRange }]
  }
  if (isObject(item) && typeof item.targetUri === 'string' && isObject(item.targetSelectionRange)) {
    return [{ path: pathFromUri(item.targetUri), range: item.targetSelectionRange as unknown as LspRange }]
  }
  return []
}

function asLocations(result: unknown): LspLocation[] {
  return Array.isArray(result) ? result.flatMap(asLocation) : asLocation(result)
}

function hoverText(result: unknown): string | null {
  if (!isObject(result)) return null
  if (typeof result.contents === 'string') return result.contents
  if (!isObject(result.contents)) return null
  const contents = result.contents
  if (typeof contents.value === 'string') return contents.value
  if (Array.isArray(contents)) {
    const text = contents
      .map((entry) => (typeof entry === 'string' ? entry : isObject(entry) && typeof entry.value === 'string' ? entry.value : ''))
      .filter((entry) => entry.length > 0)
      .join('\n')
    return text.length > 0 ? text : null
  }
  return null
}

class StdioLspClient implements LspClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private buffer = ''
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private diagnosticCache = new Map<string, LspDiagnostic[]>()
  private initialized: Promise<void> | null = null

  isEnabled(): boolean {
    return true
  }

  async diagnostics(path: string): Promise<LspDiagnostic[]> {
    await this.openDocument(path)
    return this.diagnosticCache.get(path) ?? []
  }

  async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
    await this.openDocument(path)
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: fileUri(path) },
      position: { line, character },
    })
    return asLocations(result)
  }

  async references(path: string, line: number, character: number): Promise<LspLocation[]> {
    await this.openDocument(path)
    const result = await this.request('textDocument/references', {
      textDocument: { uri: fileUri(path) },
      position: { line, character },
      context: { includeDeclaration: true },
    })
    return asLocations(result)
  }

  async hover(path: string, line: number, character: number): Promise<string | null> {
    await this.openDocument(path)
    const result = await this.request('textDocument/hover', {
      textDocument: { uri: fileUri(path) },
      position: { line, character },
    })
    return hoverText(result)
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized
    this.child = spawn('typescript-language-server', ['--stdio'])
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')))
    this.child.on('error', (err) => this.rejectAll(err))
    this.child.on('close', () => this.rejectAll(new Error('typescript-language-server exited')))
    this.initialized = this.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    }).then(() => {
      this.notify('initialized', {})
    })
    return this.initialized
  }

  private async openDocument(path: string): Promise<void> {
    await this.ensureStarted()
    const text = await readFile(path, 'utf8')
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: fileUri(path),
        languageId: 'typescript',
        version: 1,
        text,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return response
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(payload: unknown): void {
    if (!this.child) return
    this.child.stdin.write(encodeMessage(payload))
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.slice(0, headerEnd)
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) return
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) return
      const body = this.buffer.slice(bodyStart, bodyEnd)
      this.buffer = this.buffer.slice(bodyEnd)
      this.handle(JSON.parse(body) as RpcResponse | JsonRpcNotification)
    }
  }

  private handle(message: RpcResponse | JsonRpcNotification): void {
    if ('method' in message && message.method === 'textDocument/publishDiagnostics') {
      this.storeDiagnostics(message.params)
      return
    }
    if (!('id' in message) || message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if ('error' in message && message.error) pending.reject(new Error(message.error.message ?? 'LSP request failed'))
    else pending.resolve(message.result)
  }

  private storeDiagnostics(params: unknown): void {
    if (!isObject(params)) return
    const payload = params as PublishDiagnosticsParams
    if (typeof payload.uri !== 'string' || !Array.isArray(payload.diagnostics)) return
    const path = pathFromUri(payload.uri)
    this.diagnosticCache.set(
      path,
      payload.diagnostics.map((diagnostic) => ({
        path,
        range: diagnostic.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: severityNames.get(diagnostic.severity ?? 0) ?? 'unknown',
        message: diagnostic.message ?? '',
      })),
    )
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
  }
}

export function createLspClient(env: NodeJS.ProcessEnv = process.env): LspClient {
  if (env.STEER_LSP !== '1') return disabledClient()
  return new StdioLspClient()
}
