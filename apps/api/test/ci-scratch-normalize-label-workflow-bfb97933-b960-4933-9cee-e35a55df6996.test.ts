import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it.each(['', '   ', '\t\n'])('normalizes an empty label %j', (label) => {
    expect(normalizeLabel(label)).toBe('')
  })

  it.each([
    ['  hello  ', 'hello'],
    ['  hello   world  ', 'hello world'],
    ['\thello\t\nworld\n', 'hello world'],
    ['hello world', 'hello world'],
  ])('normalizes a spaced label %j', (label, expected) => {
    expect(normalizeLabel(label)).toBe(expected)
  })
})
