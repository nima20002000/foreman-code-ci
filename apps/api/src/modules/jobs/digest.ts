import { sha256CanonicalJsonHex } from '../../shared/hash.js'

export function jobDigest(value: unknown): string {
  return sha256CanonicalJsonHex(value)
}
