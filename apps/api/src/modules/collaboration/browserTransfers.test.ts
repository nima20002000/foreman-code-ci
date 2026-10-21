import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { BrowserByteTransfers } from './browserByteTransfers.js'

it('replays a lost upload admission without starting a second native transfer', async () => {
  const collected: number[] = []
  let opens = 0
  const transfers = new BrowserByteTransfers(() => ({
    upload: async (_envelope, chunks) => { opens++; for await (const chunk of chunks) collected.push(...chunk); return { saved: true } },
    download: async () => { throw new Error('Unexpected download') },
  }))
  const id = randomUUID(), envelope = { authorizationId: randomUUID(), kind: 'upload' as const, value: { fileId: 'file' } }
  try {
    await transfers.openUpload('connection', id, envelope)
    await expect(transfers.openUpload('connection', id, envelope)).resolves.toEqual({ opened: true })
    await expect(transfers.openUpload('foreign', id, envelope)).rejects.toThrow()
    await expect(transfers.openUpload('connection', id, { ...envelope, value: { fileId: 'other' } })).rejects.toThrow()
    await transfers.write('connection', id, 0, Uint8Array.of(1, 2))
    await transfers.write('connection', id, 0, Uint8Array.of(1, 2))
    expect(await transfers.finish('connection', id)).toEqual({ saved: true })
    expect(collected).toEqual([1, 2]); expect(opens).toBe(1)
  } finally { await transfers.closeAll() }
})

it('replays download admission and the last chunk without advancing the source', async () => {
  let opens = 0
  const transfers = new BrowserByteTransfers(() => ({
    upload: async () => { throw new Error('Unexpected upload') },
    download: async () => { opens++; return (async function* () { yield Uint8Array.of(3); yield Uint8Array.of(4) })() },
  }))
  const id = randomUUID(), envelope = { authorizationId: randomUUID(), kind: 'download' as const, value: { fileId: 'file' } }
  try {
    await transfers.openDownload('connection', id, envelope)
    await expect(transfers.openDownload('connection', id, envelope)).resolves.toEqual({ opened: true })
    await expect(transfers.read('foreign', id, 0)).rejects.toThrow()
    expect(await transfers.read('connection', id, 0)).toMatchObject({ bytes: Uint8Array.of(3) })
    expect(await transfers.read('connection', id, 0)).toMatchObject({ bytes: Uint8Array.of(3) })
    expect(await transfers.read('connection', id, 1)).toMatchObject({ bytes: Uint8Array.of(4) })
    expect(opens).toBe(1)
  } finally { await transfers.closeAll() }
})
