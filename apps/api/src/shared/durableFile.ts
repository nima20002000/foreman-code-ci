import { readFile, stat } from 'node:fs/promises'
export { writeDurableFile } from '@foreman-code/contracts/server-kit'

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
