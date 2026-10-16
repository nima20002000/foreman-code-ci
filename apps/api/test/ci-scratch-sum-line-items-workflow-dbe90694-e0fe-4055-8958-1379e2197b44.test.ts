import { describe, expect, it } from 'vitest'

type LineItem = { quantity: number; price: number }

function sumLineItems(items: LineItem[]): number {
  return items.reduce((total, item) => total + item.quantity * item.price, 0)
}

describe('sumLineItems', () => {
  it('returns zero for an empty list', () => {
    expect(sumLineItems([])).toBe(0)
  })

  it('sums quantity times price for multiple items', () => {
    expect(
      sumLineItems([
        { quantity: 2, price: 3 },
        { quantity: 4, price: 5 },
        { quantity: 1, price: 8 },
      ]),
    ).toBe(34)
  })
})
