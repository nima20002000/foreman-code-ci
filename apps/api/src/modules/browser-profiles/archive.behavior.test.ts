import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BrowserSnapshotArchive } from './archive.js'
import { browserInputHash } from './identity.js'
import type { BrowserSnapshotTransfer } from './types.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('leaves no ciphertext or temporary metadata behind when the manifest cannot be written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-')); roots.push(root)
  const bytes = Buffer.from('ciphertext')
  const snapshot = { profileId: 'profile', publishedRevision: 1, sha256: createHash('sha256').update(bytes).digest('hex'), format: 'cookies-localstorage-v1' as const }
  const transfer: BrowserSnapshotTransfer = { snapshot, manifest: { snapshot, sourceComputerId: 'source',
    createdAt: '2026-01-01T00:00:00.000Z', byteLength: bytes.length, origins: [], unsupportedState: [] } }
  // A directory squatting on the manifest name makes the final rename fail after the ciphertext was already placed.
  await mkdir(join(root, `${browserInputHash(snapshot)}.manifest.json`, 'blocker'), { recursive: true })
  const archive = new BrowserSnapshotArchive(root)
  await expect(archive.put(transfer, (async function* () { yield bytes })())).rejects.toThrow()
  expect(await readdir(root)).toEqual([`${browserInputHash(snapshot)}.manifest.json`])
})
