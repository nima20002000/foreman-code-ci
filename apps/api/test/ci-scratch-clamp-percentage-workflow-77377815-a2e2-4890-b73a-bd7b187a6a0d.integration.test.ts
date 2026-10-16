import { describe, expect, it } from 'vitest'

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

describe('clampPercentage', () => {
  it('clamps values below zero to zero', () => {
    expect(clampPercentage(-1)).toBe(0)
  })

  it('keeps values within the percentage bounds', () => {
    expect(clampPercentage(42)).toBe(42)
  })

  it('clamps values above one hundred to one hundred', () => {
    expect(clampPercentage(101)).toBe(100)
  })
})
