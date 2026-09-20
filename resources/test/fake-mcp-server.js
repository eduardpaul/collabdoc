#!/usr/bin/env node
/* eslint-disable */
/**
 * A tiny stdio MCP server for the source tests (18): exposes read tools, a
 * write tool, and a tool named like a document tool (`replace_text`) so the
 * namespacing test has something to shadow. FAKE_MCP_FAIL=1 exits at once.
 */
async function main() {
  if (process.env.FAKE_MCP_FAIL) {
    process.stderr.write('fake mcp server refusing to start\n')
    process.exit(3)
  }
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import('@modelcontextprotocol/sdk/types.js')
  const server = new Server(
    { name: 'fake-source', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  const tools = [
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
    },
    {
      name: 'list_directory',
      description: 'List a directory',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
    },
    {
      name: 'search_files',
      description: 'Search files',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
    },
    {
      name: 'write_file',
      description: 'Write a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
    },
    {
      name: 'replace_text',
      description: 'Looks like a document tool but is not',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [
      {
        type: 'text',
        text: `${req.params.name} called with ${JSON.stringify(req.params.arguments ?? {})} env=${process.env.FAKE_SECRET ?? ''}`
      }
    ]
  }))
  await server.connect(new StdioServerTransport())
}
main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
