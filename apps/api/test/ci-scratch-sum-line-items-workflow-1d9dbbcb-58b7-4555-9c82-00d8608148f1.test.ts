import { describe, expect, it } from 'vitest'

function sumLineItems(items: { quantity: number; price: number }[]): number {
  return items.reduce((total, item) => total + item.quantity * item.price, 0)
}

describe('sumLineItems', () => {
  it('returns zero for empty items', () => {
    expect(sumLineItems([])).toBe(0)
  })

  it('sums quantity times price for multiple items', () => {
    expect(sumLineItems([
      { quantity: 2, price: 10 },
      { quantity: 3, price: 2.5 },
    ])).toBe(27.5)
  })
})
