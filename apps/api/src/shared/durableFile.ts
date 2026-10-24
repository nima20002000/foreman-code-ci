import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The one durable record primitive for state that must survive a crash (journals, archives, tombstones).
 * A write is complete only after the bytes, the rename and the parent directory are on disk, so a reader sees the old
 * record or the new one, never a partial file. Callers keep their own schemas, paths and locking. */
export async function writeDurableFile(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
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
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export interface BoundedRead { maxBytes: number; message: string }

/** Reads a text record, refusing one over `limit.maxBytes` before and after reading. A missing file rejects with ENOENT. */
export async function readBoundedText(path: string, limit: BoundedRead): Promise<string> {
  if ((await stat(path)).size > limit.maxBytes) throw new Error(limit.message)
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text) > limit.maxBytes) throw new Error(limit.message)
  return text
}

/** Like `readBoundedText`, but a missing file is `undefined`; every other failure still rejects. */
export async function readBoundedTextIfPresent(path: string, limit: BoundedRead): Promise<string | undefined> {
  try {
    return await readBoundedText(path, limit)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
