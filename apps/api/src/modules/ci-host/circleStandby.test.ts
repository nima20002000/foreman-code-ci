import { expect, it } from 'vitest'
import { CircleStandby, circleOrgKey, type CircleOrganization } from './circleStandby.js'
import { CircleCreditCache } from './circleCreditCache.js'
import type { CircleCreditsReading } from './circleCredits.js'

function fixture() {
  let now = Date.parse('2026-10-17T12:00:00Z')
  const orgs: CircleOrganization[] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((owner, index) => ({
    owner, circleAccountId: index < 3 ? 'default' : 'reserve', role: index < 3 ? 'primary' : 'standby',
    mirrorNames: new Set(['site-ci']), ready: true,
  }))
  const remaining = new Map(orgs.map(org => [org.owner, 400_000 as number | null]))
  const readings = { reading: async (owner?: string): Promise<CircleCreditsReading> => {
    const value = remaining.get(owner!)
    return value === null || value === undefined ? { credits: null, creditsUnavailable: 'Usage unavailable.' }
      : { credits: { total: 400_000, used: 400_000 - value, remaining: value, asOf: new Date(now).toISOString() } }
  } }
  const cache = new CircleCreditCache()
  const selector = () => new CircleStandby(async () => orgs, readings, cache, () => now)
  const standby = selector()
  const roles = async (mirror = 'site-ci') => {
    const result = await standby.roles(mirror)
    return orgs.map(org => result.get(circleOrgKey(org.owner, org.circleAccountId))!.schedulingRole)
  }
  return { orgs, remaining, standby, roles, selector, setTime: (value: string) => { now = Date.parse(value) } }
}

it('replaces exhausted primaries one for one in normalized owner order, including the 20,000 reserve', async () => {
  const f = fixture()
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
  f.remaining.set('alpha', 20_001)
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
  f.remaining.set('alpha', 20_000)
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'active', 'standby', 'standby'])
  f.remaining.set('beta', 1)
  expect(await f.roles()).toEqual(['exhausted', 'exhausted', 'active', 'active', 'active', 'standby'])
  f.remaining.set('gamma', 0)
  expect(await f.roles()).toEqual(['exhausted', 'exhausted', 'exhausted', 'active', 'active', 'active'])
})

it('requires mirror availability, authentication and a known healthy reading for a first standby activation', async () => {
  const f = fixture()
  f.remaining.set('alpha', 0)
  f.orgs[3]!.mirrorNames = new Set()
  f.orgs[4]!.ready = false
  f.remaining.set('zeta', null)
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'standby', 'standby', 'standby'])
  f.remaining.set('zeta', 20_001)
  expect((await f.roles())[5]).toBe('active')
  expect(await f.roles('another-ci')).not.toContain('active')
})

it('does not activate overflow for unknown primary usage or a failed primary credential', async () => {
  const f = fixture()
  f.remaining.set('alpha', null)
  f.orgs[0]!.ready = false
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
})

it('retains exhaustion and an activated replacement through stale reads and service recreation', async () => {
  const f = fixture()
  f.remaining.set('alpha', 20_000)
  await f.roles()
  f.remaining.set('alpha', null)
  f.remaining.set('delta', null)
  const result = await f.selector().roles('site-ci')
  expect(result.get(circleOrgKey('alpha'))).toMatchObject({ schedulingRole: 'exhausted', credits: null })
  expect(result.get(circleOrgKey('delta', 'reserve'))).toMatchObject({ schedulingRole: 'active', credits: null,
    creditsUnavailable: 'Usage unavailable.' })
  f.remaining.set('alpha', 25_000)
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
})

it('retires an exhausted replacement and resets all assignments at UTC month start', async () => {
  const f = fixture()
  f.remaining.set('alpha', 0)
  await f.roles()
  f.remaining.set('delta', 20_000)
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'exhausted', 'active', 'standby'])
  f.setTime('2026-11-01T00:00:00Z')
  for (const org of f.orgs) f.remaining.set(org.owner, null)
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
})
