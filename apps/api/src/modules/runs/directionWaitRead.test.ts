import { describe, expect, it } from 'vitest'
import { findingText } from './directionWaitRead.js'

describe('direction wait finding text', () => {
  it('shows a structured finding as its own sentence, not JSON', () => {
    expect(findingText({ kind: 'entry_activation', detail: 'No specific work task provided at entry point' }))
      .toBe('No specific work task provided at entry point')
    expect(findingText({ code: 'x', reason: 'Needs a target repository' })).toBe('Needs a target repository')
  })
})
