import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it.each(['', '   ', '\t\n'])('normalizes an empty label %j', (label) => {
    expect(normalizeLabel(label)).toBe('')
  })

  it.each([
    ['  Project label  ', 'Project label'],
    ['Project   label', 'Project label'],
    [' \tProject\n\tlabel  ', 'Project label'],
    ['Project label', 'Project label'],
  ])('normalizes the spaced label %j', (label, expected) => {
    expect(normalizeLabel(label)).toBe(expected)
  })
})
