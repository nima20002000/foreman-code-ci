import { createHash } from 'node:crypto'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'

// One-shot SHA-256 digests. Strings are hashed as UTF-8, exactly like `createHash('sha256').update(string)`.
// Incremental hashing (several `update` calls or a stream) still uses `createHash` directly.

export function sha256Hex(data: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256Digest(data: string | NodeJS.ArrayBufferView): Buffer {
  return createHash('sha256').update(data).digest()
}

/** SHA-256 of the shared canonical JSON form, so equal values hash equally wherever they are built. */
export function sha256CanonicalJsonHex(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
