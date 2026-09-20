import { execFile, type ChildProcess } from 'child_process'
import crossSpawn from 'cross-spawn'
import { access, mkdir, readdir, rm, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, isAbsolute, join } from 'path'
import { RUN_LIMITS, type BackendAvailability, type RunError } from '../../shared/agents'
import type { CliProfile, LaunchContext, LaunchPlan, SourceEntry } from './cli-profiles'
import { createParser, type ParsedEvent } from './stream-parsers'
import { compareVersions, parseVersion } from './version'

export type CliRunJob = {
  runId: string
  agentId: string
  prompt: string
  systemPrompt: string
  maxTurns: number
  timeoutMs: number
  /** The document server as the CLI should register it; `name` prefixes its tools. */
  doc: { name: string; url: string; headers: Record<string, string> }
  sources: SourceEntry[]
  signal: AbortSignal
}

export type CliRunHandlers = {
  onEvent: (event: ParsedEvent) => void
  onStderr?: (line: string) => void
  onSpawned?: (pid: number, command: string) => void
}

export type CliRunOutcome = {
  status: 'done' | 'error' | 'cancelled' | 'limit'
  exitCode: number | null
  stderrTail: string[]
  error: RunError | null
  /** The launch, secrets redacted and long arguments elided. */
  command: string
  /** Where the process ran. */
  cwd: string
}

export type CliBackendOptions = {
  userData: string
  /** Extra directories to look in besides PATH (tests point this at a stub). */
  extraPathDirs?: string[]
  /** Override the search entirely (tests). */
  resolveBinary?: (binary: string) => Promise<string | null>
  probeTimeoutMs?: number
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number
}

const PROBE_TIMEOUT_MS = 15_000
const PROBE_OUTPUT_CAP = 4 * 1024 * 1024
const KILL_GRACE_MS = 1_000
/** A CLI whose result says it ran out of turns stopped for a limit, whatever its exit code. */
const MAX_TURNS_RE = /max_turns|max turns|turn limit/i
/** Files a run writes that carry the document token or source secrets. */
const SECRET_FILES = ['mcp.json', '.grok/config.toml', '.gemini/settings.json']

/**
 * One locally installed CLI agent as a backend (17): find it, check its
 * version and sign-in, and run it headlessly for one turn inside a private
 * scratch dir with CollabDoc's MCP server as its document access.
 */
export class CliBackend {
  readonly profile: CliProfile
  private readonly options: CliBackendOptions
  private cached: BackendAvailability | null = null

  constructor(profile: CliProfile, options: CliBackendOptions) {
    this.profile = profile
    this.options = options
  }

  get id(): CliProfile['id'] {
    return this.profile.id
  }

  /** Where the process may write: `userData/agents/<agentId>/work/`. */
  scratchDir(agentId: string): string {
    return join(this.options.userData, 'agents', safeSegment(agentId), 'work')
  }

  async detect(force = false): Promise<BackendAvailability> {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < 60_000) return this.cached
    const result = await this.probe()
    this.cached = result
    return result
  }

  private async probe(): Promise<BackendAvailability> {
    const { profile } = this
    const base: BackendAvailability = {
      id: profile.id,
      label: profile.label,
      available: false,
      path: null,
      version: null,
      minVersion: profile.minVersion,
      auth: 'unknown',
      reason: null,
      installHint: profile.installHint,
      verified: profile.verified,
      checkedAt: Date.now()
    }
    if (!profile.binary) return { ...base, reason: 'No command configured.' }
    const path = await this.resolveBinary(profile.binary)
    if (!path) return { ...base, reason: `${profile.binary} was not found on PATH.` }
    const versionProbe = await this.exec(path, profile.versionArgs)
    const version = parseVersion(`${versionProbe.stdout}\n${versionProbe.stderr}`)
    if (versionProbe.code !== 0 && !version) {
      return {
        ...base,
        path,
        reason: `${profile.binary} ${profile.versionArgs.join(' ')} failed: ${tail(versionProbe.stderr) || 'no output'}`
      }
    }
    if (profile.minVersion && version && compareVersions(version, profile.minVersion) < 0) {
      return {
        ...base,
        path,
        version,
        reason: `${profile.label} ${version} is older than the ${profile.minVersion} this build was verified with. Upgrade it.`
      }
    }
    let auth: BackendAvailability['auth'] = 'unknown'
    if (profile.authCheck) {
      const probe = await this.exec(path, profile.authCheck.args)
      auth = profile.authCheck.status(probe)
    }
    if (auth === 'missing') {
      return {
        ...base,
        path,
        version,
        auth,
        reason: `${profile.label} is installed but not signed in. Run: ${profile.authCheck?.fix ?? 'its login command'}`
      }
    }
    return { ...base, path, version, auth, available: true }
  }

  /**
   * Run one turn. Resolves when the process has exited and post-run cleanup
   * finished; events stream through the handlers meanwhile.
   */
  async run(job: CliRunJob, handlers: CliRunHandlers): Promise<CliRunOutcome> {
    const availability = await this.detect()
    const cwd = this.scratchDir(job.agentId)
    if (!availability.available || !availability.path) {
      return {
        status: 'error',
        exitCode: null,
        stderrTail: [],
        error: {
          kind: availability.auth === 'missing' ? 'auth' : 'not_available',
          message: availability.reason ?? `${this.profile.label} is not available.`,
          stderrTail: [],
          exitCode: null
        },
        command: '',
        cwd
      }
    }
    const binary = availability.path
    const ctx: LaunchContext = {
      prompt: job.prompt,
      systemPrompt: job.systemPrompt,
      maxTurns: job.maxTurns,
      timeoutMs: job.timeoutMs,
      cwd,
      doc: job.doc,
      sources: job.sources
    }
    const plan = this.profile.launch(ctx)
    const command = redact([binary, ...plan.args], job.doc.headers, job.sources)
    await this.prepareScratch(cwd, plan)
    const env = mergeEnv(plan.env)
    try {
      for (const pre of plan.preRun) {
        const result = await this.exec(binary, pre, cwd, env)
        if (result.code !== 0) {
          return {
            status: 'error',
            exitCode: result.code,
            stderrTail: tailLines(result.stderr),
            error: {
              kind: 'spawn',
              message: `${this.profile.binary} ${pre.slice(0, 2).join(' ')} failed before the run.`,
              stderrTail: tailLines(result.stderr),
              exitCode: result.code
            },
            command,
            cwd
          }
        }
      }
      if (job.signal.aborted) return cancelled(command, cwd)
      return await this.spawnRun(binary, plan, env, cwd, job, handlers, command)
    } finally {
      for (const post of plan.postRun) {
        await this.exec(binary, post, cwd, env).catch(() => undefined)
      }
      await this.scrubSecrets(cwd)
    }
  }

  private spawnRun(
    binary: string,
    plan: LaunchPlan,
    env: NodeJS.ProcessEnv,
    cwd: string,
    job: CliRunJob,
    handlers: CliRunHandlers,
    command: string
  ): Promise<CliRunOutcome> {
    return new Promise<CliRunOutcome>((resolve) => {
      const parser = createParser(this.profile.parser)
      const stderr: string[] = []
      let settled = false
      let timedOut = false
      let cancelledByUser = false
      let child: ChildProcess
      try {
        // cross-spawn runs npm's `.cmd` shims through cmd.exe with escaped arguments;
        // Node itself refuses to spawn them without a shell (EINVAL).
        child = crossSpawn(binary, plan.args, {
          cwd,
          env,
          stdio: [plan.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          // A process group of its own so cancel can take the CLI's children with it.
          detached: process.platform !== 'win32',
          windowsHide: true
        })
      } catch (error) {
        resolve({
          status: 'error',
          exitCode: null,
          stderrTail: [],
          error: {
            kind: 'spawn',
            message: error instanceof Error ? error.message : String(error),
            stderrTail: [],
            exitCode: null
          },
          command,
          cwd
        })
        return
      }
      if (plan.stdin !== null && child.stdin) {
        child.stdin.end(plan.stdin)
      }
      if (child.pid) handlers.onSpawned?.(child.pid, command)
      let resultEvent: Extract<ParsedEvent, { type: 'result' }> | null = null
      let errorEvent: Extract<ParsedEvent, { type: 'error' }> | null = null
      const emit = (events: ParsedEvent[]): void => {
        for (const event of events) {
          if (event.type === 'result') resultEvent = event
          if (event.type === 'error') errorEvent = event
          handlers.onEvent(event)
        }
      }
      readLines(child.stdout!, (line) => emit(parser.push(line)))
      readLines(child.stderr!, (line) => {
        stderr.push(line)
        if (stderr.length > RUN_LIMITS.stderrTailLines * 4)
          stderr.splice(0, stderr.length - RUN_LIMITS.stderrTailLines * 2)
        handlers.onStderr?.(line)
      })
      const killTree = (): void => killProcessTree(child, this.options.killGraceMs ?? KILL_GRACE_MS)
      const onAbort = (): void => {
        cancelledByUser = true
        killTree()
      }
      if (job.signal.aborted) onAbort()
      else job.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, job.timeoutMs)
      const finish = (code: number | null, spawnError?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        job.signal.removeEventListener('abort', onAbort)
        emit(parser.finish())
        const stderrTail = stderr.slice(-RUN_LIMITS.stderrTailLines)
        if (spawnError) {
          resolve({
            status: 'error',
            exitCode: null,
            stderrTail,
            error: { kind: 'spawn', message: spawnError.message, stderrTail, exitCode: null },
            command,
            cwd
          })
          return
        }
        if (cancelledByUser) {
          resolve(cancelled(command, cwd, stderrTail, code))
          return
        }
        if (timedOut) {
          resolve({
            status: 'limit',
            exitCode: code,
            stderrTail,
            error: {
              kind: 'timeout',
              message: `The run exceeded ${Math.round(job.timeoutMs / 1000)} s and was stopped.`,
              stderrTail,
              exitCode: code
            },
            command,
            cwd
          })
          return
        }
        const detail = resultEvent?.detail ?? ''
        if (MAX_TURNS_RE.test(detail) || MAX_TURNS_RE.test(errorEvent?.message ?? '')) {
          resolve({
            status: 'limit',
            exitCode: code,
            stderrTail,
            error: {
              kind: 'exit',
              message: resultEvent?.detail ?? errorEvent?.message ?? 'The CLI ran out of turns.',
              stderrTail,
              exitCode: code
            },
            command,
            cwd
          })
          return
        }
        if (code !== 0) {
          const authLike = /auth|login|sign in|unauthori[sz]ed|credential|401|expired/i.test(
            `${stderrTail.join('\n')}\n${resultEvent?.detail ?? ''}\n${errorEvent?.message ?? ''}`
          )
          resolve({
            status: 'error',
            exitCode: code,
            stderrTail,
            error: {
              kind: authLike ? 'auth' : 'exit',
              message:
                errorEvent?.message ??
                resultEvent?.detail ??
                `${this.profile.label} exited with code ${code ?? 'null'}.`,
              stderrTail,
              exitCode: code
            },
            command,
            cwd
          })
          return
        }
        if (resultEvent?.isError) {
          resolve({
            status: 'error',
            exitCode: code,
            stderrTail,
            error: {
              kind: 'exit',
              message: resultEvent.detail ?? 'The CLI reported an error.',
              stderrTail,
              exitCode: code
            },
            command,
            cwd
          })
          return
        }
        resolve({ status: 'done', exitCode: code, stderrTail, error: null, command, cwd })
      }
      child.once('error', (error) => finish(null, error))
      child.once('close', (code) => finish(code))
    })
  }

  private async prepareScratch(cwd: string, plan: LaunchPlan): Promise<void> {
    // Empty at the start of every run: nothing from the user's disk, nothing from last time.
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    for (const file of plan.files) {
      const target = join(cwd, file.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, file.content, { encoding: 'utf8', mode: 0o600 })
    }
  }

  private async scrubSecrets(cwd: string): Promise<void> {
    for (const file of SECRET_FILES)
      await rm(join(cwd, file), { force: true }).catch(() => undefined)
  }

  private async resolveBinary(binary: string): Promise<string | null> {
    if (this.options.resolveBinary) return this.options.resolveBinary(binary)
    return findBinary(binary, this.options.extraPathDirs ?? [])
  }

  /** Run a short command to completion (version/auth probes, pre/post-run steps). */
  private exec(
    file: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const timeoutMs = this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = crossSpawn(file, args, {
          cwd,
          env: env ?? mergeEnv({}),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : '' })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const cap = (text: string, chunk: string): string =>
        text.length > PROBE_OUTPUT_CAP ? text : text + chunk
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout = cap(stdout, chunk)))
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr = cap(stderr, chunk)))
      const timer = setTimeout(() => {
        stderr += `\n(timed out after ${Math.round(timeoutMs / 1000)} s)`
        killProcessTree(child, KILL_GRACE_MS)
      }, timeoutMs)
      const done = (code: number | null, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) stderr += `\n${error.message}`
        resolve({ code: error ? 1 : (code ?? 1), stdout, stderr })
      }
      child.once('error', (error) => done(null, error))
      child.once('close', (code) => done(code))
    })
  }
}

// ---- helpers -------------------------------------------------------------------

function cancelled(
  command: string,
  cwd: string,
  stderrTail: string[] = [],
  exitCode: number | null = null
): CliRunOutcome {
  return {
    status: 'cancelled',
    exitCode,
    stderrTail,
    error: { kind: 'cancelled', message: 'Cancelled.', stderrTail, exitCode },
    command,
    cwd
  }
}

function killProcessTree(child: ChildProcess, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  const pid = child.pid
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }
  signal('SIGTERM')
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
  }, graceMs)
  child.once('close', () => clearTimeout(hard))
}

function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.length > 0) onLine(line)
      index = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0) onLine(buffer)
  })
}

function mergeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COLLABDOC_RUN: '1' }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function tailLines(text: string, n: number = RUN_LIMITS.stderrTailLines): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-n)
}

function tail(text: string): string {
  return tailLines(text, 2).join(' ')
}

function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'agent'
}

/** The command for the run record: token and source secrets hidden, long args elided. */
export function redact(
  args: string[],
  docHeaders: Record<string, string>,
  sources: SourceEntry[]
): string {
  const secrets = new Set<string>()
  for (const value of Object.values(docHeaders)) secrets.add(value.replace(/^Bearer\s+/i, ''))
  for (const source of sources) {
    for (const value of Object.values(source.headers ?? {}))
      secrets.add(value.replace(/^Bearer\s+/i, ''))
    for (const value of Object.values(source.env ?? {})) secrets.add(value)
  }
  return args
    .map((arg) => {
      let out = arg
      for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('•••')
      if (out.length > 80) out = `${out.slice(0, 77)}…`
      return /[\s"']/.test(out) || out === '' ? JSON.stringify(out) : out
    })
    .join(' ')
}

const WINDOWS_EXTENSIONS = ['.cmd', '.exe', '.bat', '']

/** Look for an executable on PATH and in the places CLI installers like. */
export async function findBinary(binary: string, extraDirs: string[] = []): Promise<string | null> {
  if (isAbsolute(binary)) return (await isExecutable(binary)) ? binary : null
  const home = homedir()
  const dirs = [
    ...extraDirs,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.codex', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : [])
  ]
  for (const nvmBin of await nvmBinDirs(home)) dirs.push(nvmBin)
  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : ['']
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${binary}${ext}`)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return null
}

async function nvmBinDirs(home: string): Promise<string[]> {
  const root = join(home, '.nvm', 'versions', 'node')
  try {
    const versions = await readdir(root)
    return versions
      .sort((a, b) => compareVersions(parseVersion(b) ?? '0', parseVersion(a) ?? '0'))
      .map((v) => join(root, v, 'bin'))
  } catch {
    return []
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}
