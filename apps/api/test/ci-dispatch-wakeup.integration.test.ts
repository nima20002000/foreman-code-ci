import { expect, it, vi } from 'vitest'
import { fixture } from './helpers/hostCiMcpFixture.js'

const settle = () => new Promise(done => setTimeout(done, 20))

it('runs another dispatch pass for a wake-up requested at any microtask while a pass finishes', async () => {
  const f = await fixture()
  try {
    const pass = vi.spyOn(f.ci as unknown as { dispatchOnce(): Promise<void> }, 'dispatchOnce').mockResolvedValue(undefined)
    // The wake-up lands k microtasks after the pass starts, sweeping across the moment the pass is ending.
    for (let k = 0; k <= 40; k++) {
      pass.mockClear()
      const first = f.ci.dispatch()
      let chain = Promise.resolve()
      for (let tick = 0; tick < k; tick++) chain = chain.then(() => undefined)
      void chain.then(() => f.ci.dispatch())
      await first
      await settle()
      expect(pass.mock.calls.length, `wake-up after ${k} microtasks`).toBeGreaterThanOrEqual(2)
    }
  } finally { await f.close() }
})
