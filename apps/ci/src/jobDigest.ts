import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { sha256Hex } from '@foreman-code/contracts/server-kit'

export function jobDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
