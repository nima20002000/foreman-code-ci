import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty string for empty and whitespace-only labels', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel('  \t\n  ')).toBe('')
  })

  it('trims and collapses whitespace in spaced labels', () => {
    expect(normalizeLabel('  hello   world  ')).toBe('hello world')
    expect(normalizeLabel('\t hello\n\tworld \n')).toBe('hello world')
  })
})
