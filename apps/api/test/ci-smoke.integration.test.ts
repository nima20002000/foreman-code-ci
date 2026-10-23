import { expect, it } from 'vitest'
import { ciGroupState } from '@foreman-code/ci/parts'

it('reports a CI group passed only when its jobs have passed', () => {
  expect(ciGroupState([{ state: 'passed' }])).toBe('passed')
  expect(ciGroupState([{ state: 'passed' }, { state: 'failed' }])).toBe('failed')
  expect(ciGroupState([{ state: 'passed' }, { state: 'queued' }])).toBe('queued')
})
