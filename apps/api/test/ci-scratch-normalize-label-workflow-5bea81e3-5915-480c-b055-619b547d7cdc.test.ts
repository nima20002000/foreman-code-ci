import { describe, expect, it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

describe('normalizeLabel', () => {
  it.each(['', '   ', '\t\n'])('normalizes empty or whitespace-only input %j', (label) => {
    expect(normalizeLabel(label)).toBe('')
  })

  it('trims whitespace around a label', () => {
    expect(normalizeLabel('  Project label  ')).toBe('Project label')
  })

  it('collapses spaces, tabs, and newlines within a label', () => {
    expect(normalizeLabel('  Project   label\twith\nspaces  ')).toBe('Project label with spaces')
  })
})
