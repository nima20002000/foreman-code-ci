import { describe, expect, it } from 'vitest';

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

describe('clampPercentage', () => {
  it.each([-100, -1, -0.5])('clamps %s below the lower bound to 0', (value) => {
    expect(clampPercentage(value)).toBe(0);
  });

  it.each([0, 1, 42.5, 99, 100])('preserves %s within the bounds', (value) => {
    expect(clampPercentage(value)).toBe(value);
  });

  it.each([100.5, 101, 200])('clamps %s above the upper bound to 100', (value) => {
    expect(clampPercentage(value)).toBe(100);
  });
});
