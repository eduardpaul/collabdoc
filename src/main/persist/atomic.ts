import { open, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import { mkdir } from 'fs/promises'

export type AtomicWriteOptions = {
  /** Test hook: throw after the tmp file is fsynced, before rename. */
  failBeforeRename?: boolean
}

/**
 * Write `bytes` to `filePath` as write-tmp → fsync → rename.
 * A crash between tmp write and rename leaves the previous file intact.
 */
export async function atomicWriteFile(
  filePath: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (options.failBeforeRename) {
    throw new Error('simulated failure before rename')
  }
  try {
    await rename(tmpPath, filePath)
  } catch (error) {
    // Windows cannot rename over an existing file; replace via a bak hop.
    const bakPath = `${filePath}.bak`
    try {
      await rename(filePath, bakPath)
      await rename(tmpPath, filePath)
      await unlink(bakPath).catch(() => undefined)
    } catch (replaceError) {
      throw replaceError instanceof Error ? replaceError : error
    }
  }
}
