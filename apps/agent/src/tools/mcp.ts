import type { ToolFn } from './index.js'

export type McpServerConfig =
  | {
      name: string
      transport: 'stdio'
      command: string
      args?: string[]
    }
  | {
      name: string
      transport: 'http' | 'sse'
      url: string
    }

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpConnection {
  name: string
  tools: McpToolDefinition[]
  callTool(tool: string, args: Record<string, unknown>): Promise<string>
}

export interface McpDynamicToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const EMPTY_INPUT_SCHEMA = { type: 'object', properties: {} } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseJsonConfig(raw: string): McpServerConfig[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry) => (isRecord(entry) ? parseServerConfig(entry) : []))
}

function parseServerConfig(entry: Record<string, unknown>): McpServerConfig[] {
  if (!nonEmpty(entry.name)) return []
  if (nonEmpty(entry.command)) {
    if (entry.args !== undefined && !isStringArray(entry.args)) return []
    return [{ name: entry.name, transport: 'stdio', command: entry.command, args: entry.args }]
  }
  if (nonEmpty(entry.url)) {
    const transport = entry.transport === 'sse' ? 'sse' : 'http'
    return [{ name: entry.name, transport, url: entry.url }]
  }
  return []
}

function parseDelimitedConfig(raw: string): McpServerConfig[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => {
      const separator = entry.indexOf('=')
      if (separator <= 0) return []
      const name = entry.slice(0, separator).trim()
      const url = entry.slice(separator + 1).trim()
      return nonEmpty(name) && nonEmpty(url) ? [{ name, transport: 'http' as const, url }] : []
    })
}

export function parseMcpConfig(env: Partial<Pick<NodeJS.ProcessEnv, 'STEER_MCP_SERVERS'>>): McpServerConfig[] {
  const raw = env.STEER_MCP_SERVERS?.trim()
  if (!raw) return []
  try {
    if (raw.startsWith('[') || raw.startsWith('{')) return parseJsonConfig(raw)
    return parseDelimitedConfig(raw)
  } catch {
    return []
  }
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp:${server}/${tool}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function validateArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(args)) throw new Error('arguments must be an object')
  return args
}

export function makeMcpTool(
  callTool: (args: Record<string, unknown>) => Promise<string>,
  namespacedName: string,
): ToolFn {
  return async (args) => {
    try {
      return await callTool(validateArgs(args))
    } catch (err) {
      return `error: ${namespacedName} failed: ${errorMessage(err)}`
    }
  }
}

export function buildMcpTools(connections: readonly McpConnection[]): Record<string, ToolFn> {
  return Object.fromEntries(
    connections.flatMap((connection) =>
      connection.tools.map((tool) => {
        const namespacedName = mcpToolName(connection.name, tool.name)
        return [
          namespacedName,
          makeMcpTool((args) => connection.callTool(tool.name, args), namespacedName),
        ] as const
      }),
    ),
  )
}

export function buildMcpToolDefinitions(connections: readonly McpConnection[]): McpDynamicToolDefinition[] {
  return connections.flatMap((connection) =>
    connection.tools.map((tool) => {
      const name = mcpToolName(connection.name, tool.name)
      return {
        name,
        description: tool.description ?? name,
        inputSchema: tool.inputSchema ?? EMPTY_INPUT_SCHEMA,
      }
    }),
  )
}
