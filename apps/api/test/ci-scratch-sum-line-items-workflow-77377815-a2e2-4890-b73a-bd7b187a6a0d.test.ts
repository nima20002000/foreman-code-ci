import { describe, expect, it } from 'vitest'

type LineItem = { quantity: number; price: number }

function sumLineItems(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.price, 0)
}

describe('sumLineItems', () => {
  it('returns zero for an empty list', () => {
    expect(sumLineItems([])).toBe(0)
  })

  it('sums quantity times price for multiple items', () => {
    expect(sumLineItems([
      { quantity: 2, price: 3.5 },
      { quantity: 4, price: 2 },
      { quantity: 1, price: 10 },
    ])).toBe(25)
  })
})
