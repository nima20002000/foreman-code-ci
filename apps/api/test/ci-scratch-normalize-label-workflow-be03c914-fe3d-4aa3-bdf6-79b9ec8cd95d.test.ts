import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it.each(['', '   ', '\t\n'])('normalizes empty or whitespace-only labels: %j', (label) => {
    expect(normalizeLabel(label)).toBe('')
  })

  it.each([
    ['  Project label  ', 'Project label'],
    ['Project   label', 'Project label'],
    [' \tProject\n\t label \r\n', 'Project label'],
    ['Project label', 'Project label'],
  ])('normalizes spaced labels: %j', (label, expected) => {
    expect(normalizeLabel(label)).toBe(expected)
  })
})
