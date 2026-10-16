import { describe, expect, it } from 'vitest'

function sumLineItems(items: Array<{ quantity: number; price: number }>): number {
  return items.reduce((total, item) => total + item.quantity * item.price, 0)
}

describe('sumLineItems', () => {
  it('returns zero for an empty list', () => {
    expect(sumLineItems([])).toBe(0)
  })

  it('sums quantity times price for multiple items', () => {
    expect(sumLineItems([
      { quantity: 2, price: 12.5 },
      { quantity: 3, price: 4 },
    ])).toBe(37)
  })
})
