import { describe, expect, it } from 'vitest'

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

describe('clampPercentage', () => {
  it('clamps values below zero to zero', () => {
    expect(clampPercentage(-12)).toBe(0)
  })

  it('keeps values within the percentage range', () => {
    expect(clampPercentage(42)).toBe(42)
  })

  it('clamps values above 100 to 100', () => {
    expect(clampPercentage(125)).toBe(100)
  })
})
