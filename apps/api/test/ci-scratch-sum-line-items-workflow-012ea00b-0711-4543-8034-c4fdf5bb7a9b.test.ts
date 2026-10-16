import { describe, expect, it } from 'vitest'

type LineItem = { quantity: number; price: number }

function sumLineItems(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.price, 0)
}

describe('line item totals', () => {
  it('returns zero for no line items', () => {
    expect(sumLineItems([])).toBe(0)
  })

  it('sums quantity times price across multiple line items', () => {
    expect(sumLineItems([
      { quantity: 2, price: 3.5 },
      { quantity: 4, price: 1.25 },
      { quantity: 1, price: 10 },
    ])).toBe(18)
  })
})
