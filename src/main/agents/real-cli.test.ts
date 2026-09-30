// @vitest-environment node
/**
 * Runs the real, locally installed CLIs against the document MCP server.
 * Opt-in: COLLABDOC_REAL_CLI=claude-code,codex,grok,antigravity npx vitest run real-cli
 * Each CLI uses the user's own sign-in and takes a minute or two.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { listHistory } from '../../core/history'
import { DocumentRegistry } from '../../core/registry'
import { addParagraph, human } from '../../core/test-helpers'
import { allBlocks, blockPlainText } from '../../core/tree'
import { isBackendId, type BackendId, type RunRecord, type RunRequest } from '../../shared/agents'
import { DocumentMcpServer } from '../mcp/DocumentMcpServer'
import { AgentRuntime } from './AgentRuntime'
import { SecretStore, plainCipher } from './secrets'
import { McpSourceStore } from './sources'

const wanted = (process.env.COLLABDOC_REAL_CLI ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(isBackendId) as BackendId[]

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe.skipIf(wanted.length === 0)('real CLI backends (opt-in)', () => {
  for (const backendId of wanted) {
    it(`${backendId}: persona writes are attributed (Codex also reviews and cancels)`, async () => {
      const userData = await mkdtemp(join(tmpdir(), 'collabdoc-real-'))
      const registry = new DocumentRegistry({ closeDelayMs: Number.POSITIVE_INFINITY })
      const entry = registry.create({ title: 'Tides' })
      addParagraph(human(entry.hub, 'ana'), 'Tides are the rise and fall of sea levels.')
      const mcp = new DocumentMcpServer({
        registry,
        userData,
        log: (m, d) => console.log(m, d ?? '')
      })
      await mcp.init()
      const secrets = new SecretStore(userData, plainCipher)
      const sources = new McpSourceStore({ userData, secrets })
      await sources.load()
      const runtime = new AgentRuntime({
        registry,
        mcp,
        sources,
        userData,
        onEvent: (event) => {
          if (event.type === 'text') process.stdout.write(`[${backendId}] ${event.text}\n`)
          if (event.type === 'step')
            process.stdout.write(
              `[${backendId}] step ${event.step.tool} ok=${event.step.ok} ${event.step.summary}\n`
            )
          if (event.type === 'warning')
            process.stdout.write(`[${backendId}] warning ${event.message}\n`)
        },
        log: (m) => process.stdout.write(`[${backendId}] ${m}\n`)
      })
      await runtime.init()
      cleanups.push(async () => {
        await runtime.dispose()
        await mcp.stop()
        registry.closeAll()
        await rm(userData, { recursive: true, force: true })
      })

      const availability = await runtime.detect(backendId)
      console.log(`[${backendId}] detect`, availability)
      expect(availability.available, availability.reason ?? '').toBe(true)

      const before = allBlocks(entry.hub.doc).length
      const writerRequest: RunRequest = {
        docId: entry.docId,
        docTitle: 'Tides',
        kind: 'ask',
        persona: {
          id: 'agent_nova',
          name: 'Nova',
          handle: 'nova',
          role: 'writer',
          color: '#2563eb',
          instructions: 'Plain, friendly prose. One idea per paragraph.',
          skills: []
        },
        backendId,
        prompt:
          'Read the document, then insert exactly one short paragraph (two sentences) at the end ' +
          'explaining what causes tides. Do not change existing text.',
        sourceIds: []
      }
      const started = runtime.run(writerRequest)
      const record = await untilDone(runtime, started.runId, 240_000)
      console.log(`[${backendId}] record`, { ...record, transcript: record.transcript.slice(-2) })
      expect(record.status, JSON.stringify(record.error)).toBe('done')
      expect(record.steps.some((s) => s.tool === 'get_document' || s.tool === 'get_blocks')).toBe(
        true
      )
      expect(record.writes).toBeGreaterThanOrEqual(1)
      expect(allBlocks(entry.hub.doc).length).toBeGreaterThan(before)
      const last = listHistory(entry.hub.doc).at(-1)!
      expect(last.author).toMatchObject({ actorId: 'agent_nova', name: 'Nova' })
      const texts = allBlocks(entry.hub.doc).map(({ node }) => blockPlainText(node))
      console.log(`[${backendId}] document now:\n${texts.join('\n')}`)
      expect(mcp.sessionsForRun(record.runId)).toBe(0)

      if (backendId === 'codex') {
        const review = runtime.run({
          ...writerRequest,
          persona: {
            ...writerRequest.persona,
            id: 'agent_rex',
            name: 'Rex',
            handle: 'rex',
            role: 'reviewer'
          },
          prompt:
            'Read the document and add exactly one brief comment to the tides paragraph suggesting an improvement. Leave all document text unchanged.'
        })
        const reviewed = await untilDone(runtime, review.runId, 240_000)
        expect(reviewed.status, JSON.stringify(reviewed.error)).toBe('done')
        expect(reviewed.steps.some((s) => s.tool === 'add_comment' && s.ok)).toBe(true)
        expect(allBlocks(entry.hub.doc).map(({ node }) => blockPlainText(node))).toEqual(texts)
        expect(mcp.sessionsForRun(reviewed.runId)).toBe(0)

        const pending = runtime.run({
          ...writerRequest,
          prompt: 'Read the document and explain tides in detail without editing it.'
        })
        const deadline = Date.now() + 10_000
        while (!runtime.getRun(pending.runId)?.command && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
        expect(runtime.getRun(pending.runId)?.command).toBeTruthy()
        const cancelAt = Date.now()
        expect(runtime.cancel(pending.runId)).toBe(true)
        const cancelled = await untilDone(runtime, pending.runId, 5_000)
        expect(cancelled.status).toBe('cancelled')
        expect(Date.now() - cancelAt).toBeLessThan(2_000)
        expect(mcp.sessionsForRun(cancelled.runId)).toBe(0)
      }
    }, 600_000)
  }
})

async function untilDone(
  runtime: AgentRuntime,
  runId: string,
  timeoutMs: number
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = runtime.getRun(runId)
    if (record && record.endedAt !== null) return record
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`run ${runId} did not finish in time`)
}
