import { expect, it } from 'vitest'
import { requireFullCiGrant, requiresFullCiGrant } from './fullScope.js'

it('requires the separate grant for gates and every request with an unrestricted suite', () => {
  for (const input of [
    { suite: 'unit' as const, scope: 'full' as const },
    { suite: 'unit' as const, gate: true, files: [] },
    { suite: 'integration' as const },
    { suite: 'install' as const },
    { suite: 'build' as const },
    { suite: 'typecheck' as const, files: ['apps/api/src/a.ts', 'apps/web/src/a.ts', 'packages/contracts/src/a.ts'] },
  ]) expect(requiresFullCiGrant(input)).toBe(true)
  expect(requiresFullCiGrant({ suite: 'unit' })).toBe(false)
  expect(requiresFullCiGrant({ suite: 'integration', files: [] })).toBe(false)
  expect(() => requireFullCiGrant(false)).toThrow(expect.objectContaining({ code: 'CI_FULL_SCOPE_FORBIDDEN', status: 403 }))
  expect(() => requireFullCiGrant(true)).not.toThrow()
})
