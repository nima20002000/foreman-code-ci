import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty string for empty and whitespace-only labels', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims labels and collapses internal whitespace', () => {
    expect(normalizeLabel('  Team   planning  ')).toBe('Team planning')
    expect(normalizeLabel('\tTeam\n\t planning\r\n')).toBe('Team planning')
  })
})
