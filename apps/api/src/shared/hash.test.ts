import { expect, it } from 'vitest'
import { sha256CanonicalJsonHex, sha256Digest, sha256Hex } from './hash.js'

it('hashes strings as UTF-8 and bytes as given', () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  expect(sha256Hex('')).toBe(empty)
  expect(sha256Hex(Buffer.alloc(0))).toBe(empty)
  expect(sha256Hex('é')).toBe(sha256Hex(Buffer.from('é', 'utf8')))
  expect(sha256Digest('abc').toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

it('hashes values by their canonical JSON form regardless of key order', () => {
  expect(sha256CanonicalJsonHex({ b: 1, a: [2, { d: 3, c: 4 }] }))
    .toBe(sha256CanonicalJsonHex({ a: [2, { c: 4, d: 3 }], b: 1 }))
  expect(sha256CanonicalJsonHex({ a: 1 })).not.toBe(sha256CanonicalJsonHex({ a: 2 }))
})
