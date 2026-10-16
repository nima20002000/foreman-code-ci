import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty string for empty and whitespace-only labels', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims and collapses whitespace in spaced labels', () => {
    expect(normalizeLabel('  Project   label  ')).toBe('Project label')
    expect(normalizeLabel('\tProject\n\tlabel\r\n ')).toBe('Project label')
  })
})
