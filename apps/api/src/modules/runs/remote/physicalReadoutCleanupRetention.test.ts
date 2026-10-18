import { describe, expect, it } from 'vitest'
import { InstalledWorkflowPhysicalReadouts, remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'

describe('physical readout retention while an operation is being cleaned up', () => {
  it('retains the cleanup reply of an operation whose every slot Main still holds, and still refuses an ordinary reply', async () => {
    const f = await physicalFixture(), readouts = new InstalledWorkflowPhysicalReadouts()
    const history = (index: number) => ({ ...f.source.history, nextSequence: index })
    const observation = (index: number, cleanup = false) => ({ readout: { ...f.readout, history: history(index) },
      placement: f.placement, source: { type: 'history' as const, history: history(index) },
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
      observe: () => f.captured.launch, closure: () => null, ...(cleanup ? { cleanup: true } : {}) })
    const selector = (index: number) => ({ intent: f.intent, placement: f.placement,
      receiptSequence: f.readout.receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: history(index) }) })
    try {
      for (let index = 0; index < 128; index++) {
        readouts.remember(observation(index))
        await readouts.read(selector(index))
      }
      expect(() => readouts.remember(observation(128)))
        .toThrow(expect.objectContaining({ code: 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE' }))
      // Cancel and close replies free the operation's capacity; refusing them would wedge its closure forever.
      expect(() => readouts.remember(observation(129, true))).not.toThrow()
      expect((await readouts.read(selector(129))).history).toEqual(history(129))
      // Only the operation's oldest observation yields; Main re-reads it as an expired reply.
      await expect(readouts.read(selector(0))).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'not_retained' } })
      expect((await readouts.read(selector(1))).history).toEqual(history(1))
    } finally { await f.sqlConnection.close() }
  })
})
