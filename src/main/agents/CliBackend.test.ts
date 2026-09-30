// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParsedEvent } from './stream-parsers'
import { CLI_PROFILES } from './cli-profiles'
import { CliBackend, findBinary, type CliRunJob } from './CliBackend'

const FAKE = resolve(__dirname, '../../../resources/test/fake-cli.js')

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  delete process.env.FAKE_CLI_MODE
  delete process.env.FAKE_CLI_VERSION
  delete process.env.FAKE_CLI_LOGGED_OUT
})

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A PATH dir where `claude` is the stub, plus a userData dir. */
async function backend(options: { binaryName?: string } = {}): Promise<{
  backend: CliBackend
  userData: string
  bin: string
}> {
  const bin = await tmp('collabdoc-bin-')
  const userData = await tmp('collabdoc-userdata-')
  await symlink(FAKE, join(bin, options.binaryName ?? 'claude'))
  const cli = new CliBackend(CLI_PROFILES['claude-code'], {
    userData,
    extraPathDirs: [bin],
    killGraceMs: 300
  })
  return { backend: cli, userData, bin }
}

function job(overrides: Partial<CliRunJob> = {}): CliRunJob {
  return {
    runId: 'run_1',
    agentId: 'agent_writer',
    prompt: 'Draft an intro about tides.',
    systemPrompt: 'You are Nova.',
    maxTurns: 6,
    timeoutMs: 20_000,
    doc: {
      name: 'collabdoc',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'Bearer secret-token-0123456789' }
    },
    sources: [],
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('CliBackend · detect (AC-17.1)', () => {
  it('finds the binary via the extra PATH dirs and reports version and auth', async () => {
    const { backend: cli, bin } = await backend()
    const found = await cli.detect(true)
    expect(found).toMatchObject({
      id: 'claude-code',
      available: true,
      version: '9.9.9',
      auth: 'ok'
    })
    expect(found.path).toBe(join(bin, 'claude'))
    expect(found.reason).toBeNull()
  })

  it('explains a missing binary and how to install it; the backend is not available', async () => {
    const userData = await tmp('collabdoc-userdata-')
    const cli = new CliBackend(CLI_PROFILES['claude-code'], {
      userData,
      resolveBinary: async () => null
    })
    const found = await cli.detect(true)
    expect(found.available).toBe(false)
    expect(found.reason).toMatch(/not found/)
    expect(found.installHint).toMatch(/claude/)
  })

  it('refuses a version older than the pinned minimum with a message (AC-17.7)', async () => {
    const { backend: cli } = await backend()
    process.env.FAKE_CLI_VERSION = '1.0.3'
    const found = await cli.detect(true)
    expect(found.available).toBe(false)
    expect(found.version).toBe('1.0.3')
    expect(found.reason).toMatch(/older than the 2\.0\.0/)
  })

  it('reports a signed-out CLI as not available with the login command', async () => {
    const { backend: cli } = await backend()
    process.env.FAKE_CLI_LOGGED_OUT = '1'
    const found = await cli.detect(true)
    expect(found).toMatchObject({ available: false, auth: 'missing' })
    expect(found.reason).toMatch(/claude auth login/)
  })

  it('findBinary walks PATH-like dirs and returns null for unknown names', async () => {
    const { bin } = await backend({ binaryName: 'grok' })
    expect(await findBinary('grok', [bin])).toBe(join(bin, 'grok'))
    expect(await findBinary('definitely-not-a-cli-xyz', [bin])).toBeNull()
  })
})

describe('CliBackend · run', () => {
  it('streams parsed events and ends done; the recorded command hides the token', async () => {
    const { backend: cli, userData } = await backend()
    process.env.FAKE_CLI_MODE = 'ok'
    const events: ParsedEvent[] = []
    const outcome = await cli.run(job(), { onEvent: (e) => events.push(e) })
    expect(outcome.status).toBe('done')
    expect(outcome.exitCode).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['init', 'text', 'tool_use', 'tool_result', 'result'])
    expect(outcome.command).not.toContain('secret-token-0123456789')
    expect(outcome.command).toContain('--strict-mcp-config')
    expect(outcome.cwd).toBe(join(userData, 'agents', 'agent_writer', 'work'))
    // The MCP config carried the token and is gone after the run.
    await expect(stat(join(outcome.cwd, 'mcp.json'))).rejects.toThrow()
  })

  it('runs in the scratch dir: a file the CLI "saves" lands there and nowhere else (AC-17.3)', async () => {
    const { backend: cli, userData } = await backend()
    process.env.FAKE_CLI_MODE = 'write-outside'
    const outcome = await cli.run(job(), { onEvent: () => undefined })
    expect(outcome.status).toBe('done')
    const scratch = join(userData, 'agents', 'agent_writer', 'work')
    expect(await readFile(join(scratch, 'notes.md'), 'utf8')).toMatch(/copy/)
    // userData holds only the agents tree; nothing escaped next to it.
    expect(await readdir(userData)).toEqual(['agents'])
    expect(await readdir(join(userData, 'agents'))).toEqual(['agent_writer'])
  })

  it('cancel kills the CLI and its child within 2 s and ends cancelled (AC-17.5)', async () => {
    const { backend: cli, userData } = await backend()
    process.env.FAKE_CLI_MODE = 'sleep'
    const controller = new AbortController()
    let pid = 0
    const started = Date.now()
    const run = cli.run(job({ signal: controller.signal }), {
      onEvent: (event) => {
        if (event.type === 'init') controller.abort()
      },
      onSpawned: (spawned) => {
        pid = spawned
      }
    })
    const outcome = await run
    expect(outcome.status).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(pid).toBeGreaterThan(0)
    // The stub ignored SIGTERM, so the backend escalated; both processes are gone.
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(pid, 0)).toThrow()
    const childPid = Number(
      await readFile(join(userData, 'agents', 'agent_writer', 'work', 'child.pid'), 'utf8')
    )
    expect(childPid).toBeGreaterThan(0)
    await waitGone(childPid)
  })

  it('a non-zero exit surfaces a typed error with the last 20 stderr lines (AC-17.6)', async () => {
    const { backend: cli } = await backend()
    process.env.FAKE_CLI_MODE = 'fail'
    const outcome = await cli.run(job(), { onEvent: () => undefined })
    expect(outcome.status).toBe('error')
    expect(outcome.error).toMatchObject({ kind: 'exit', exitCode: 2 })
    expect(outcome.error!.stderrTail).toHaveLength(20)
    expect(outcome.error!.stderrTail.at(-1)).toBe('detail line 30')
    expect(outcome.error!.stderrTail[0]).toBe('detail line 11')
  })

  it('auth-looking failures are typed `auth`', async () => {
    const { backend: cli } = await backend()
    process.env.FAKE_CLI_MODE = 'auth'
    const outcome = await cli.run(job(), { onEvent: () => undefined })
    expect(outcome.status).toBe('error')
    expect(outcome.error?.kind).toBe('auth')
    expect(outcome.error?.stderrTail[0]).toMatch(/Not logged in/)
  })

  it('running out of turns is `limit` even when the CLI exits non-zero', async () => {
    const { backend: cli } = await backend()
    process.env.FAKE_CLI_MODE = 'max-turns'
    const outcome = await cli.run(job(), { onEvent: () => undefined })
    expect(outcome.status).toBe('limit')
    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toMatchObject({ kind: 'exit', message: 'error_max_turns' })
  })

  it('the wall clock stops a hung run with `limit` / timeout', async () => {
    const { backend: cli } = await backend()
    process.env.FAKE_CLI_MODE = 'sleep'
    const outcome = await cli.run(job({ timeoutMs: 400 }), { onEvent: () => undefined })
    expect(outcome.status).toBe('limit')
    expect(outcome.error?.kind).toBe('timeout')
  })

  it('a backend that is not available fails fast without spawning', async () => {
    const userData = await tmp('collabdoc-userdata-')
    const cli = new CliBackend(CLI_PROFILES['claude-code'], {
      userData,
      resolveBinary: async () => null
    })
    const outcome = await cli.run(job(), { onEvent: () => undefined })
    expect(outcome.status).toBe('error')
    expect(outcome.error?.kind).toBe('not_available')
  })
})

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`process ${pid} still alive`)
}

describe('CliBackend · Codex detection', () => {
  it('refuses versions below the verified minimum and explains sign-in failures', async () => {
    const userData = await tmp('collabdoc-codex-')
    const cli = new CliBackend(CLI_PROFILES.codex, { userData, resolveBinary: async () => FAKE })
    process.env.FAKE_CLI_VERSION = '0.158.0'
    expect(await cli.detect(true)).toMatchObject({
      available: false,
      reason: expect.stringContaining('0.159.2')
    })
    process.env.FAKE_CLI_VERSION = '0.159.2'
    process.env.FAKE_CLI_LOGGED_OUT = '1'
    expect(await cli.detect(true)).toMatchObject({
      available: false,
      auth: 'missing',
      reason: expect.stringContaining('codex login')
    })
  })
})
