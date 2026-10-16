import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty string for empty or whitespace-only labels', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims labels and collapses spaces, tabs, and newlines', () => {
    expect(normalizeLabel('  Project   planning  ')).toBe('Project planning')
    expect(normalizeLabel('\tProject\t\n planning\n')).toBe('Project planning')
  })
})
