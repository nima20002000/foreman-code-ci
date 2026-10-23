import { describe, expect, it } from 'vitest'
import { late } from './late.js'

describe('late slot', () => {
  it('names the service when it is read before the stage that builds it ran', () => {
    expect(() => late<string>('widgets').get()).toThrow('widgets is used before the stage that builds it ran.')
  })

  it('returns the bound service, and the value it was bound with', () => {
    const slot = late<{ id: number }>('widgets')
    const widgets = { id: 1 }
    expect(slot.bind(widgets)).toBe(widgets)
    expect(slot.get()).toBe(widgets)
  })

  it('holds a bound undefined as built', () => {
    const slot = late<string | undefined>('optional widgets')
    slot.bind(undefined)
    expect(slot.get()).toBeUndefined()
  })
})
