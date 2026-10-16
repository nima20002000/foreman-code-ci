import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('label normalization', () => {
  it('returns an empty string for an empty label', () => {
    expect(normalizeLabel('')).toBe('')
  })

  it('trims labels and collapses whitespace', () => {
    expect(normalizeLabel('  weekly\tworkflow\nrun  ')).toBe('weekly workflow run')
  })
})
