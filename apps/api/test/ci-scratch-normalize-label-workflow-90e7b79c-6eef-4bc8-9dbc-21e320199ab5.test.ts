import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty label for empty or whitespace-only input', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims and collapses whitespace in spaced labels', () => {
    expect(normalizeLabel('  Project   planning  ')).toBe('Project planning')
    expect(normalizeLabel('\tProject\n\t planning\r\n session\t')).toBe('Project planning session')
    expect(normalizeLabel('Project planning')).toBe('Project planning')
  })
})
