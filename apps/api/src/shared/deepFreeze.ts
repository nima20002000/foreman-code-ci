import { canonicalGraphJson } from '@foreman-code/contracts/current'

/** Freezes a value and everything reachable from it, so a retained pin or captured fact cannot change afterwards. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** A frozen canonical-JSON copy of `value`; a value over `maxBytes` is rejected. */
export function frozenJsonCopy<T>(value: T, maxBytes = 4 * 1024 * 1024): T {
  return deepFreeze(JSON.parse(canonicalGraphJson(value, maxBytes)) as T)
}
