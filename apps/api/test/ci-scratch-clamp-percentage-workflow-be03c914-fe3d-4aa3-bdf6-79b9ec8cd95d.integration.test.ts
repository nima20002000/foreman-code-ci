import { describe, expect, it } from 'vitest'

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

describe('clampPercentage', () => {
  it('clamps values below zero to zero', () => {
    expect(clampPercentage(-10)).toBe(0)
  })

  it('preserves values within the bounds', () => {
    expect(clampPercentage(42.5)).toBe(42.5)
  })

  it('preserves both endpoints', () => {
    expect(clampPercentage(0)).toBe(0)
    expect(clampPercentage(100)).toBe(100)
  })

  it('clamps values above one hundred to one hundred', () => {
    expect(clampPercentage(125)).toBe(100)
  })
})
