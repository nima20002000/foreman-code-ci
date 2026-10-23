import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { sha256Hex } from '@foreman-code/contracts/server-kit'

// One-shot SHA-256 digests live in the contracts server kit so the API and CI share them.
// Incremental hashing (several `update` calls or a stream) still uses `createHash` directly.
export { sha256Hex, sha256Digest } from '@foreman-code/contracts/server-kit'

/** SHA-256 of the shared canonical JSON form, so equal values hash equally wherever they are built. */
export function sha256CanonicalJsonHex(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
