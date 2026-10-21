import { it } from 'vitest'
import { assertWorkerOutputSettlement } from './helpers/workerOutputSettlement.js'

it('adopts the original Worker artifact after output settlement', async () => {
  await assertWorkerOutputSettlement('artifact')
}, 240000)
