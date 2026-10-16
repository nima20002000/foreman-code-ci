import { describe, expect, it } from 'vitest';

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

describe('normalizeLabel', () => {
  it.each(['', '   ', '\t\n'])('normalizes an empty label %j', (label) => {
    expect(normalizeLabel(label)).toBe('');
  });

  it.each([
    ['  Hello   world  ', 'Hello world'],
    ['\tHello\n\tworld\n', 'Hello world'],
    ['Hello world', 'Hello world'],
  ])('normalizes a spaced label %j', (label, expected) => {
    expect(normalizeLabel(label)).toBe(expected);
  });
});
