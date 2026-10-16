import { describe, expect, it } from 'vitest';

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

describe('label normalization', () => {
  it('returns an empty string for whitespace-only labels', () => {
    expect(normalizeLabel(' \t\n ')).toBe('');
  });

  it('trims labels and collapses internal whitespace', () => {
    expect(normalizeLabel('  review\t  workflow\n label  ')).toBe('review workflow label');
  });
});
