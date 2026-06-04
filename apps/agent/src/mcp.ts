import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpConnection, McpServerConfig } from './tools/mcp.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function createTransport(config: McpServerConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: 'inherit',
    })
  }

  const url = new URL(config.url)
  return config.transport === 'sse'
    ? new SSEClientTransport(url)
    : new StreamableHTTPClientTransport(url)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textFromContent(content: unknown): string {
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') return content.text
  if (isRecord(content) && content.type === 'resource' && isRecord(content.resource)) {
    if (typeof content.resource.text === 'string') return content.resource.text
    if (typeof content.resource.blob === 'string') return content.resource.blob
  }
  return JSON.stringify(content)
}

function formatToolResult(result: unknown): string {
  if (!isRecord(result)) return String(result)
  if ('toolResult' in result) return JSON.stringify(result.toolResult)

  const content = Array.isArray(result.content) ? result.content.map(textFromContent).join('\n') : JSON.stringify(result)
  return result.isError === true ? `error: ${content}` : content
}

async function connectOne(config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: 'steer-agent', version: '0.0.0' }, { capabilities: {} })
  await client.connect(createTransport(config))
  const listed = await client.listTools()

  return {
    name: config.name,
    tools: listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    callTool: async (tool, args) => formatToolResult(await client.callTool({ name: tool, arguments: args })),
  }
}

export async function connectMcpServers(configs: readonly McpServerConfig[]): Promise<McpConnection[]> {
  const connections: McpConnection[] = []
  for (const config of configs) {
    try {
      connections.push(await connectOne(config))
    } catch (err) {
      console.warn(`MCP server ${config.name} unavailable; skipping: ${errorMessage(err)}`)
    }
  }
  return connections
}
