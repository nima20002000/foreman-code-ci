import { expect, it } from 'vitest'

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

it('clamps percentages below zero to zero', () => {
  expect(clampPercentage(-1)).toBe(0)
})

it('keeps percentages within the range unchanged', () => {
  expect(clampPercentage(42)).toBe(42)
})

it('clamps percentages above one hundred to one hundred', () => {
  expect(clampPercentage(101)).toBe(100)
})
