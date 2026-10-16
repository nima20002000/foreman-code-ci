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
    expect(normalizeLabel('  Project   planning  ')).toBe('Project planning')
    expect(normalizeLabel('\tProject\n\t planning\r\n')).toBe('Project planning')
  })

  it('preserves labels with normalized spacing', () => {
    expect(normalizeLabel('Project planning')).toBe('Project planning')
  })
})
