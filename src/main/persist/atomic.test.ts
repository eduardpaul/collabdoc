// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteFile } from './atomic'

describe('atomicWriteFile', () => {
  let dir = ''

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('replaces the file and leaves the previous bytes if rename never happens (AC-04.4)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'collabdoc-atomic-'))
    const file = join(dir, 'note.collabdoc')
    await writeFile(file, 'version-one')
    await expect(
      atomicWriteFile(file, Buffer.from('version-two'), { failBeforeRename: true })
    ).rejects.toThrow(/simulated failure/)
    expect(await readFile(file, 'utf8')).toBe('version-one')
    const tmp = await readFile(`${file}.tmp`, 'utf8')
    expect(tmp).toBe('version-two')
  })

  it('writes the new bytes when the rename completes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'collabdoc-atomic-'))
    const file = join(dir, 'note.collabdoc')
    await writeFile(file, 'version-one')
    await atomicWriteFile(file, Buffer.from('version-two'))
    expect(await readFile(file, 'utf8')).toBe('version-two')
  })
})
