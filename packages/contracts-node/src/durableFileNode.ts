import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The one durable record primitive for state that must survive a crash (journals, archives, tombstones).
 * By default a write is complete only after the bytes, the rename and the parent directory are on disk, so a reader sees the old
 * record or the new one, never a partial file. Callers keep their own schemas, paths and locking. */
export async function writeDurableFile(path: string, content: string | Uint8Array, options: {
  /** Callers that already prepare or validate the directory keep ownership of that step. */
  createParent?: boolean
  /** Cache records retain their weaker directory durability policy. */
  syncDirectory?: boolean
  temporaryPath?: string
} = {}): Promise<void> {
  if (options.createParent !== false) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = options.temporaryPath ?? `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(content)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  if (options.syncDirectory === false) return
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}
