import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it('returns an empty label for empty or whitespace-only input', () => {
    expect(normalizeLabel('')).toBe('')
    expect(normalizeLabel(' \t\n ')).toBe('')
  })

  it('trims labels and collapses internal whitespace', () => {
    expect(normalizeLabel('  Project   status  ')).toBe('Project status')
    expect(normalizeLabel('\tProject\n\tstatus\t')).toBe('Project status')
    expect(normalizeLabel('Project status')).toBe('Project status')
  })
})
