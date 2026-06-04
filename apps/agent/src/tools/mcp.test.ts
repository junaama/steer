import { classifyTool } from '@steer/schema'
import { describe, expect, it } from 'vitest'
import {
  buildMcpToolDefinitions,
  buildMcpTools,
  makeMcpTool,
  mcpToolName,
  parseMcpConfig,
  type McpConnection,
} from './mcp.js'

const ctx = { workspaceRoot: '/repo' }

describe('parseMcpConfig', () => {
  it('returns no servers when config is missing or empty', () => {
    expect(parseMcpConfig({})).toEqual([])
    expect(parseMcpConfig({ STEER_MCP_SERVERS: '' })).toEqual([])
    expect(parseMcpConfig({ STEER_MCP_SERVERS: '   ' })).toEqual([])
  })

  it('returns no servers for malformed config', () => {
    expect(parseMcpConfig({ STEER_MCP_SERVERS: '{' })).toEqual([])
    expect(parseMcpConfig({ STEER_MCP_SERVERS: JSON.stringify({ name: 'tracker' }) })).toEqual([])
    expect(
      parseMcpConfig({ STEER_MCP_SERVERS: JSON.stringify([null, { command: 'missing-name' }, { name: 'empty' }]) }),
    ).toEqual([])
    expect(parseMcpConfig({ STEER_MCP_SERVERS: JSON.stringify([{ name: 'bad', command: 'cmd', args: [1] }]) })).toEqual(
      [],
    )
  })

  it('parses JSON stdio and HTTP server config', () => {
    expect(
      parseMcpConfig({
        STEER_MCP_SERVERS: JSON.stringify([
          { name: 'tracker', command: 'mcp-tracker', args: ['--stdio'] },
          { name: 'browser', url: 'https://mcp.example.test/sse' },
        ]),
      }),
    ).toEqual([
      { name: 'tracker', transport: 'stdio', command: 'mcp-tracker', args: ['--stdio'] },
      { name: 'browser', transport: 'http', url: 'https://mcp.example.test/sse' },
    ])
  })

  it('parses explicit JSON SSE server config', () => {
    expect(
      parseMcpConfig({
        STEER_MCP_SERVERS: JSON.stringify([{ name: 'events', transport: 'sse', url: 'https://mcp.example.test/sse' }]),
      }),
    ).toEqual([{ name: 'events', transport: 'sse', url: 'https://mcp.example.test/sse' }])
  })

  it('parses simple delimited remote config', () => {
    expect(parseMcpConfig({ STEER_MCP_SERVERS: 'browser=https://mcp.example.test/sse' })).toEqual([
      { name: 'browser', transport: 'http', url: 'https://mcp.example.test/sse' },
    ])
  })

  it('ignores malformed simple delimited entries', () => {
    expect(parseMcpConfig({ STEER_MCP_SERVERS: 'missing-separator,=missing-name,missing-url=' })).toEqual([])
  })
})

describe('mcpToolName', () => {
  it('namespaces server and tool names exactly', () => {
    expect(mcpToolName('files', 'read')).toBe('mcp:files/read')
    expect(mcpToolName('issue-tracker', 'ticket.read/v2')).toBe('mcp:issue-tracker/ticket.read/v2')
  })
})

describe('makeMcpTool', () => {
  it('forwards args and returns the MCP result', async () => {
    const tool = makeMcpTool(async (args) => `read ${String(args.path)}`, 'mcp:files/read')

    await expect(tool({ path: 'README.md' }, ctx)).resolves.toBe('read README.md')
  })

  it('turns thrown tool failures into error strings', async () => {
    const tool = makeMcpTool(async () => {
      throw new Error('permission denied')
    }, 'mcp:files/read')

    await expect(tool({ path: 'README.md' }, ctx)).resolves.toBe('error: mcp:files/read failed: permission denied')
  })

  it('rejects non-object arguments as tool errors', async () => {
    const tool = makeMcpTool(async () => 'unreachable', 'mcp:files/read')

    await expect(tool(null as unknown as Record<string, unknown>, ctx)).resolves.toBe(
      'error: mcp:files/read failed: arguments must be an object',
    )
  })
})

describe('buildMcpTools', () => {
  it('returns no dynamic tools when no MCP connections are available', () => {
    expect(buildMcpTools([])).toEqual({})
  })

  it('registers namespaced tools and dispatches to the connection tool name', async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    const connection: McpConnection = {
      name: 'server',
      tools: [{ name: 'read' }, { name: 'write' }],
      callTool: async (tool, args) => {
        calls.push({ tool, args })
        return `${tool}:${String(args.path)}`
      },
    }

    const dynamicTools = buildMcpTools([connection])
    const readTool = dynamicTools['mcp:server/read']

    expect(Object.keys(dynamicTools).sort()).toEqual(['mcp:server/read', 'mcp:server/write'])
    if (!readTool) throw new Error('missing mcp:server/read tool')
    await expect(readTool({ path: 'README.md' }, ctx)).resolves.toBe('read:README.md')
    expect(calls).toEqual([{ tool: 'read', args: { path: 'README.md' } }])
  })

  it('keeps unknown namespaced MCP tools gated as side-effecting', () => {
    expect(classifyTool('mcp:server/read')).toBe('side-effecting')
  })
})

describe('buildMcpToolDefinitions', () => {
  it('registers namespaced model tool definitions with MCP input schemas', () => {
    const connection: McpConnection = {
      name: 'server',
      tools: [
        {
          name: 'read',
          description: 'Read an issue',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
        { name: 'write' },
      ],
      callTool: async () => 'ok',
    }

    expect(buildMcpToolDefinitions([connection])).toEqual([
      {
        name: 'mcp:server/read',
        description: 'Read an issue',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'mcp:server/write',
        description: 'mcp:server/write',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
  })
})
