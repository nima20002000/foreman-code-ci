import { expect, it, vi } from 'vitest'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import { MainClock } from '../../devices/workerClock.js'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

it.each([-90_000, 5_000, 90_000])(
  'serves a full Main-clock observation window with a %s ms Worker offset', async offset => {
    const mainTime = Date.now()
    let elapsed = 0
    const mainClock = new MainClock(() => elapsed)
    mainClock.observe(mainTime)
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(mainTime + offset)
    const f = await runningInstalledFixture('generation', { mainNow: () => mainClock.now() })
    try {
      const read = async () => {
        const status = await f.journal.status(f.intent.operationId)
        if (status.status !== 'known') throw new Error('Expected running operation')
        return RemoteWorkflowPhysicalReadoutSchema.parse((await f.call('physical-readout', {
          receiptSequence: status.receipt.sequence,
          sourceDigest: remoteWorkflowSourceDigest({ type: 'boundary' }),
        })).payload)
      }
      await f.call('status')
      expect((await read()).expiresAt).toBe(new Date(mainTime + 60_000).toISOString())
      elapsed = 60_001
      wallClock.mockReturnValue(mainTime - 300_000)
      expect((await read()).expiresAt).toBe(new Date(mainTime + elapsed + 60_000).toISOString())
      wallClock.mockReturnValue(mainTime + 300_000)
      expect((await read()).expiresAt).toBe(new Date(mainTime + elapsed + 60_000).toISOString())
    } finally {
      wallClock.mockRestore()
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  },
)
