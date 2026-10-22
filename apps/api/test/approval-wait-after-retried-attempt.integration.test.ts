import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, stageDelivered, checkpointCut, recover } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('approval wait after a retried attempt', () => {
  const fixture = productionFixtures()

  it('binds a fresh attempt\'s approval despite the abandoned attempt\'s error write, then resumes on the answer', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending(), cut = await checkpointCut(f)
    const interrupted = cut.pendingWrites?.find((write) => write[1] === '__interrupt__')
    if (!interrupted || !interaction) throw new Error('Expected the persisted task interrupt')
    // LangGraph keeps the earlier attempt's error write beside the interrupt raised by its retry.
    await f.saver.putWrites(cut.config, [['__error__',
      { name: 'DomainError', message: 'This attempt was abandoned for a fresh attempt.' }]], interrupted[0])
    await recover(f)
    expect(await f.pending()).toEqual([expect.objectContaining({ id: interaction.id, status: 'pending' })])
    await stageDelivered(f)
    await recover(f)
    expect(await f.receipts()).toEqual([expect.objectContaining({ entity_id: interaction.id })])
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
  }, 60000)
})
