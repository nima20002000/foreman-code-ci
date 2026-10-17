import { expect, it } from 'vitest'
import { DEFAULT_CIRCLE_CREDIT_ALLOWANCE, type CircleCreditAllowance } from '@foreman-code/contracts/management'
import { CircleCreditUsage } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'

// A CloudHttp keeps its credential per ports object, so every fixture gets its own.
const newPorts = (): HostCiPorts => ({ run: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date(),
  cpus: 4, memoryBytes: 2 ** 30 })
/** CircleCI's real export names its columns in capitals. */
const CSV = ['PROJECT_NAME,TOTAL_CREDITS,JOB_NAME', 'site,1000,unit',
  '"site, two",234.4,"quoted ""job"""', 'site,0.2,lint', ''].join('\r\n')

/** CircleCI's HTTP at the cloud HTTP boundary: collaborations, usage export create/read, and the signed CSV link. */
function circle(options: { states?: string[]; csv?: string; csvByOrg?: Record<string, string>; collaborations?: unknown[]; token?: string | null } = {}) {
  const calls: { method: string; path: string; authorization: string | undefined; body: string | undefined }[] = []
  const states = [...options.states ?? ['completed']]
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/api/v2/me/collaborations') {
      return json(options.collaborations ?? [{ id: 'org-other', name: 'other', vcs_type: 'github' },
        { id: 'org-acme', name: 'Acme', slug: 'gh/acme', vcs_type: 'github' }])
    }
    const orgId = /\/organizations\/([^/]+)\/usage_export_job/.exec(url.pathname)?.[1]
    if (init?.method === 'POST') return json({ usage_export_job_id: `job-${orgId}`, state: 'created' }, 201)
    if (url.pathname.includes('/usage_export_job/job-')) {
      const state = states.length > 1 ? states.shift()! : states[0]!
      return json({ usage_export_job_id: `job-${orgId}`, state, download_urls: state === 'completed' ? [`https://signed.example/${orgId}.csv`] : null,
        ...(state === 'failed' ? { error_reason: 'query failed' } : {}) })
    }
    if (url.hostname === 'signed.example') return new Response(options.csvByOrg?.[url.pathname.slice(1, -4)] ?? options.csv ?? CSV)
    return json({ message: 'unexpected' }, 404)
  }
  const clock = { now: Date.parse('2026-10-17T12:00:00Z') }
  const allowance: CircleCreditAllowance = structuredClone(DEFAULT_CIRCLE_CREDIT_ALLOWANCE)
  const usage = new CircleCreditUsage(new CloudHttp(newPorts(), 'circleci', { fetch: fetchFake,
    circleToken: async () => options.token === undefined ? 'fixture-token' : options.token }),
  { allowance: async () => allowance, primaryOwner: async () => 'acme' },
  { now: () => clock.now, pollMs: 1, waitMs: 1000 })
  return { usage, calls, clock, allowance }
}
const settled = () => new Promise(resolve => setTimeout(resolve, 50))

it('estimates credits left from the month usage export and reads CircleCI only once per interval', async () => {
  const f = circle()
  expect((await f.usage.reading('acme')).credits).toBeNull()
  await settled()
  const reading = await f.usage.reading('acme')
  expect(reading).toEqual({ credits: { total: 400000, used: 1235, remaining: 398765, asOf: '2026-10-17T12:00:00.000Z' } })
  const create = f.calls.find(call => call.method === 'POST')!
  expect(JSON.parse(create.body!)).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-17T12:00:00.000Z' })
  expect(create.path).toBe('/api/v2/organizations/org-acme/usage_export_job')
  expect(f.calls.filter(call => call.authorization === 'Bearer fixture-token').length).toBeGreaterThan(0)
  const requests = f.calls.length
  f.clock.now += 9 * 60_000
  await f.usage.reading('acme')
  await f.usage.reading('acme')
  await settled()
  expect(f.calls).toHaveLength(requests)
  f.clock.now += 2 * 60_000
  await f.usage.reading('acme')
  await settled()
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2)
})

it('gives each CircleCI org its own usage against its own 400,000 open-source credits', async () => {
  const f = circle({ collaborations: [{ id: 'org-acme', name: 'acme', slug: 'gh/acme', vcs_type: 'github' },
    { id: 'org-beta', name: 'beta', slug: 'gh/beta', vcs_type: 'github' }],
  csvByOrg: { 'org-acme': 'PROJECT_NAME,TOTAL_CREDITS\nsite,125000\n', 'org-beta': 'PROJECT_NAME,TOTAL_CREDITS\nsite,380000\n' } })
  await f.usage.reading('acme')
  await f.usage.reading('beta')
  await settled()
  const asOf = '2026-10-17T12:00:00.000Z'
  expect(await f.usage.reading('acme')).toEqual({ credits: { total: 400000, used: 125000, remaining: 275000, asOf } })
  expect(await f.usage.reading('beta')).toEqual({ credits: { total: 400000, used: 380000, remaining: 20000, asOf } })
})

it('applies the saved allowance to the cached usage without another CircleCI read', async () => {
  const f = circle({ states: ['processing', 'completed'] })
  await f.usage.reading('acme')
  await settled()
  f.allowance.accounts = { ACME: 1500 }
  const requests = f.calls.length
  expect((await f.usage.reading('acme')).credits).toMatchObject({ total: 1500, used: 1235, remaining: 265 })
  expect(f.calls).toHaveLength(requests)
})

it('reports credits unavailable with the reason instead of a made-up number', async () => {
  const failed = circle({ states: ['failed'] })
  await failed.usage.reading('acme')
  await settled()
  expect(await failed.usage.reading('acme')).toEqual({ credits: null,
    creditsUnavailable: 'CircleCI usage export failed: query failed' })
  const loggedOut = circle({ token: null })
  await loggedOut.usage.reading()
  await settled()
  expect(await loggedOut.usage.reading()).toEqual({ credits: null, creditsUnavailable: 'CircleCI is not logged in on Main.' })
  const unknownOrg = circle({ collaborations: [] })
  await unknownOrg.usage.reading('acme')
  await settled()
  expect((await unknownOrg.usage.reading('acme')).creditsUnavailable).toContain('acme')
})

it('drops a reading from an earlier month', async () => {
  const f = circle()
  await f.usage.reading('acme')
  await settled()
  expect((await f.usage.reading('acme')).credits).not.toBeNull()
  f.clock.now = Date.parse('2026-11-01T00:05:00Z')
  expect((await f.usage.reading('acme')).credits).toBeNull()
})
