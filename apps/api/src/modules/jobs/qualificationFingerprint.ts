// Fingerprints one qualification path without loading the rest of qualification, so Workers and CI can measure paths.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'

export async function fingerprintQualificationPath(path: string, executable = false) {
  const canonical = await realpath(path)
  if (canonical !== path) throw new Error('Qualification paths must be canonical, without symlink retargeting.')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (executable && (!before.isFile() || before.size > 268435456n || (before.mode & 0o022n) || !(before.mode & 0o111n))) throw new Error('Executable trust boundary rejected.')
    if (!executable && !before.isDirectory()) throw new Error('Canonical directory required.')
    const digest = executable ? await fingerprintExecutableBytes(handle, 268435456) : null
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Path changed during qualification.')
    return { path: canonical, device: String(before.dev), inode: String(before.ino), mode: String(before.mode), uid: String(before.uid), gid: String(before.gid), sha256: digest }
  } finally { await handle.close() }
}

async function fingerprintExecutableBytes(handle: Awaited<ReturnType<typeof open>>, maximum: number) {
  const before = await handle.stat({ bigint: true })
  if (!before.isFile() || before.size > BigInt(maximum)) throw new Error('Fingerprint file exceeds its bound.')
  const digest = createHash('sha256')
  const buffer = Buffer.alloc(Math.min(Number(before.size), 1048576))
  let offset = 0
  while (offset < Number(before.size)) {
    const read = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset)
    if (!read.bytesRead) throw new Error('Fingerprint file changed during read.')
    digest.update(buffer.subarray(0, read.bytesRead))
    offset += read.bytesRead
  }
  const after = await handle.stat({ bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error('Fingerprint file changed during read.')
  }
  return digest.digest('hex')
}
