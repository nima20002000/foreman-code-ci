import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('label normalization', () => {
  it('returns an empty string for an empty or whitespace-only label', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims and collapses whitespace in a label', () => {
    expect(normalizeLabel('  release\t candidate\n  one  ')).toBe('release candidate one')
  })
})
