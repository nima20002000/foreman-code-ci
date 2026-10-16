import { describe, expect, it } from 'vitest'

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

describe('clampPercentage', () => {
  it('clamps values below zero', () => {
    expect(clampPercentage(-5)).toBe(0)
  })

  it('preserves values within the bounds', () => {
    expect(clampPercentage(42)).toBe(42)
  })

  it('clamps values above one hundred', () => {
    expect(clampPercentage(125)).toBe(100)
  })
})
