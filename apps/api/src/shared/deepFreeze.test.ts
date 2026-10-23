import { expect, it } from 'vitest'
import { deepFreeze, frozenJsonCopy } from './deepFreeze.js'

it('freezes nested objects and arrays and returns the same value', () => {
  const value = { list: [{ name: 'a' }], inner: { count: 1 } }
  const frozen = deepFreeze(value)

  expect(frozen).toBe(value)
  expect(() => { 'use strict'; frozen.list[0]!.name = 'b' }).toThrow(TypeError)
  expect(() => { 'use strict'; frozen.list.push({ name: 'c' }) }).toThrow(TypeError)
  expect(() => { 'use strict'; frozen.inner.count = 2 }).toThrow(TypeError)
})

it('leaves primitives and null alone', () => {
  expect(deepFreeze(null)).toBeNull()
  expect(deepFreeze(3)).toBe(3)
  expect(deepFreeze('text')).toBe('text')
})

it('copies a value as frozen canonical JSON without freezing the original', () => {
  const original = { b: 1, a: { c: [1, 2] } }
  const copy = frozenJsonCopy(original)

  expect(copy).toEqual(original)
  expect(copy).not.toBe(original)
  expect(Object.isFrozen(copy.a.c)).toBe(true)
  expect(Object.isFrozen(original)).toBe(false)
})

it('refuses a value over the byte limit', () => {
  expect(() => frozenJsonCopy({ text: 'x'.repeat(100) }, 32)).toThrow()
})
