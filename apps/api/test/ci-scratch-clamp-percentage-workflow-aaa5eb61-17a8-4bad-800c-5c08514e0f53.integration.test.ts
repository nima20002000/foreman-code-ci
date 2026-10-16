import { describe, expect, it } from 'vitest'

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

describe('clampPercentage', () => {
  it('clamps values below zero to zero', () => {
    expect(clampPercentage(-10)).toBe(0)
  })

  it.each([0, 25, 50.5, 100])('preserves an in-range value of %s', (value) => {
    expect(clampPercentage(value)).toBe(value)
  })

  it('clamps values above one hundred to one hundred', () => {
    expect(clampPercentage(110)).toBe(100)
  })
})
