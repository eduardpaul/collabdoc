#!/usr/bin/env node
/* eslint-disable */
/**
 * A stand-in for a CLI agent (Claude Code / grok shape) used by the backend
 * tests (AC-17.9). Behaviour is picked with FAKE_CLI_MODE:
 *
 *   ok            init → text → tool_use → result, exit 0
 *   mcp           connect to the --mcp-config server, read the outline and
 *                 insert a paragraph, then result
 *   forbidden     like mcp but try replace_text (a reviewer will be refused)
 *   sleep         init, then hang (spawns a child too) until killed
 *   fail          two stderr lines + 30 numbered ones, exit 2
 *   auth          stderr "Not logged in", exit 1
 *   max-turns     init → text → result error_max_turns, exit 1 (Claude Code's shape)
 *   write-outside write ./notes.md relative to cwd (the scratch dir), result
 *   plain         print two plain lines
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const args = process.argv.slice(2)
const mode = process.env.FAKE_CLI_MODE || 'ok'

if (args[0] === '--version') {
  console.log(process.env.FAKE_CLI_VERSION || '9.9.9 (fake-cli)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLI_LOGGED_OUT ? false : true }))
  process.exit(0)
}
if (args[0] === 'mcp') {
  // `agy mcp add/remove` stand-in: record the call so tests can assert on it.
  fs.appendFileSync(path.join(process.cwd(), 'mcp-calls.log'), `${args.join(' ')}\n`)
  process.exit(0)
}

function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const prompt = flag('-p') || flag('--prompt') || ''
const init = () =>
  emit({
    type: 'system',
    subtype: 'init',
    model: 'fake-1',
    tools: [],
    mcp_servers: [{ name: 'collabdoc', status: 'connected' }]
  })
const text = (t) =>
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
const toolUse = (name, input, id) =>
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  })
const toolResult = (id, content, isError) =>
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isError }]
    }
  })
const result = (t, isError, subtype) =>
  emit({
    type: 'result',
    subtype: subtype || (isError ? 'error' : 'success'),
    is_error: !!isError,
    result: t,
    num_turns: 1
  })

async function main() {
  switch (mode) {
    case 'ok': {
      init()
      text(`Working on: ${prompt.slice(0, 40)}`)
      toolUse('mcp__collabdoc__get_document', {}, 'tu_1')
      toolResult('tu_1', '{"blocks":[]}')
      result('Done: drafted the intro.')
      return 0
    }
    case 'plain': {
      console.log('first line')
      console.log('second line')
      return 0
    }
    case 'write-outside': {
      init()
      fs.writeFileSync(path.resolve('notes.md'), 'a copy the agent was told to save\n')
      result('Saved a copy to notes.md')
      return 0
    }
    case 'fail': {
      process.stderr.write('Something broke\n')
      process.stderr.write('Error: upstream returned 500\n')
      for (let i = 1; i <= 30; i += 1) process.stderr.write(`detail line ${i}\n`)
      return 2
    }
    case 'auth': {
      process.stderr.write('Not logged in. Run `fake login` first.\n')
      return 1
    }
    case 'max-turns': {
      init()
      text('Still working…')
      result(null, true, 'error_max_turns')
      return 1
    }
    case 'sleep': {
      // A child of our own, so a cancel has to take the whole process group.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      })
      fs.writeFileSync(path.resolve('child.pid'), String(child.pid))
      init()
      process.on('SIGTERM', () => {
        // Misbehave: ignore SIGTERM so the backend has to escalate.
      })
      await new Promise(() => {})
      return 0
    }
    case 'mcp':
    case 'forbidden': {
      init()
      const configFile = flag('--mcp-config')
      const config = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'))
      const server = config.mcpServers.collabdoc
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const client = new Client({ name: 'fake-cli', version: '9.9.9' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers }
        })
      )
      const call = async (name, input, id) => {
        toolUse(`mcp__collabdoc__${name}`, input, id)
        const res = await client.callTool({ name, arguments: input })
        const body = res.content[0].text
        toolResult(id, body, res.isError)
        return JSON.parse(body)
      }
      const outline = await call('get_document', {}, 'tu_1')
      if (mode === 'forbidden') {
        const first = outline.blocks[0]
        await call(
          'replace_text',
          { blockId: first.blockId, locator: { find: 'quick' }, text: 'slow' },
          'tu_2'
        )
        text('I could not edit the text, so I am leaving a comment instead.')
        await call('add_comment', { blockId: first.blockId, body: 'Consider "slow" here.' }, 'tu_3')
      } else {
        await call(
          'insert_blocks',
          {
            at: { relation: 'inside_end' },
            blocks: [{ type: 'paragraph', text: `Drafted intro for: ${prompt.slice(0, 30)}` }]
          },
          'tu_2'
        )
      }
      await client.close()
      result('Done.')
      return 0
    }
    default:
      process.stderr.write(`unknown FAKE_CLI_MODE ${mode}\n`)
      return 3
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
    result(String(error), true)
    process.exit(4)
  }
)
