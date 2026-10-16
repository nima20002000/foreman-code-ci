import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty string for empty and whitespace-only labels', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims labels and collapses whitespace between words', () => {
    expect(normalizeLabel('  Team   workflow  ')).toBe('Team workflow')
    expect(normalizeLabel('\tTeam\n\tworkflow\r\n label ')).toBe('Team workflow label')
    expect(normalizeLabel('Team workflow')).toBe('Team workflow')
  })
})
