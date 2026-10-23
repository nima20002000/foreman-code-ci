import { expect, it } from 'vitest'
import { errorMessage, sha256Digest, sha256Hex } from './serverKit.js'

it('preserves Error messages even when empty and uses the caller fallback for other values', () => {
  expect(errorMessage(new Error('Request failed'), 'Fallback')).toBe('Request failed')
  expect(errorMessage(new Error(''), 'Fallback')).toBe('')
  for (const error of [undefined, null, 'message', { message: 'message' }]) {
    expect(errorMessage(error, 'Fallback')).toBe('Fallback')
  }
})

it('hashes strings as UTF-8 and bytes identically', () => {
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  expect(sha256Hex('abc')).toBe(abc)
  expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(abc)
  expect(sha256Digest('abc').toString('hex')).toBe(abc)
  expect(sha256Hex('é')).toBe(sha256Hex(Buffer.from([0xc3, 0xa9])))
})
