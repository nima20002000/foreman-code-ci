import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('label normalization', () => {
  it('returns an empty string for an empty or whitespace-only label', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims a label and collapses internal whitespace', () => {
    expect(normalizeLabel('  spaced\t label\nwith   gaps  ')).toBe('spaced label with gaps')
  })
})
