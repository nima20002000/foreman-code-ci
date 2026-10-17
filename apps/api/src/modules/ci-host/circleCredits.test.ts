import { expect, it } from 'vitest'
import { DEFAULT_CIRCLE_CREDIT_ALLOWANCE, type CircleCreditAllowance } from '@foreman-code/contracts/management'
import { CircleCreditUsage, sumTotalCredits } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'

// A CloudHttp keeps its credential per ports object, so every fixture gets its own.
const newPorts = (): HostCiPorts => ({ run: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date(),
  cpus: 4, memoryBytes: 2 ** 30 })
/** CircleCI's real export names its columns in capitals. */
const csv = (...credits: number[]) => ['PROJECT_NAME,JOB_NAME,TOTAL_CREDITS', ...credits.map(value => `"site, one",unit,${value}`), ''].join('\r\n')
const ORGS = [
  { id: 'org-acme', name: 'acme', slug: 'gh/acme', vcs_type: 'github' },
  { id: 'org-beta', name: 'beta', slug: 'gh/beta', vcs_type: 'github' },
  { id: 'org-gamma', name: 'gamma', slug: 'gh/gamma', vcs_type: 'github' },
  { id: 'org-standalone', name: 'standalone', slug: 'circleci/standalone', vcs_type: 'circleci' },
]

/** CircleCI's HTTP at the cloud HTTP boundary: collaborations, usage export create/read per organization, and the signed CSV links. */
function circle(options: { usage?: Record<string, string>; failed?: string[]; token?: string | null; collaborations?: unknown[] } = {}) {
  const calls: { method: string; path: string }[] = []
  const usage = options.usage ?? { 'org-acme': csv(100_000, 25_000), 'org-beta': csv(380_000), 'org-gamma': csv(5) }
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ method: init?.method ?? 'GET', path: url.pathname })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/api/v2/me/collaborations') return json(options.collaborations ?? ORGS)
    const job = /\/organizations\/(org-[a-z]+)\/usage_export_job(?:\/job-(org-[a-z]+))?$/.exec(url.pathname)
    if (job && init?.method === 'POST') return json({ usage_export_job_id: `job-${job[1]}`, state: 'created' }, 201)
    if (job?.[2]) {
      return options.failed?.includes(job[2]) ? json({ state: 'failed', error_reason: 'query failed' })
        : json({ state: 'completed', download_urls: [`https://signed.example/${job[2]}.csv`] })
    }
    if (url.hostname === 'signed.example') return new Response(usage[url.pathname.slice(1).replace('.csv', '')] ?? csv(0))
    return json({ message: 'unexpected' }, 404)
  }
  const clock = { now: Date.parse('2026-10-17T12:00:00Z') }
  const allowance: CircleCreditAllowance = structuredClone(DEFAULT_CIRCLE_CREDIT_ALLOWANCE)
  const credits = new CircleCreditUsage(new CloudHttp(newPorts(), 'circleci', { fetch: fetchFake,
    circleToken: async () => options.token === undefined ? 'fixture-token' : options.token }),
  { allowance: async () => allowance }, { now: () => clock.now, pollMs: 1, waitMs: 1000 })
  /** The first read starts the work in the background; the next one sees its result. */
  const settledReading = async () => {
    await credits.reading()
    await new Promise(resolve => setTimeout(resolve, 80))
    return credits.reading()
  }
  return { credits, calls, clock, allowance, settledReading }
}

it('reports each GitHub organization of the login against its own 400,000 open-source credits plus the account total', async () => {
  const f = circle()
  expect(await f.credits.reading()).toEqual({ credits: null, creditsUnavailable: 'Credits are still being read.' })
  const asOf = '2026-10-17T12:00:00.000Z'
  expect(await f.settledReading()).toEqual({ credits: { orgs: [
    { org: 'acme', credits: { total: 400_000, used: 125_000, remaining: 275_000, asOf } },
    { org: 'beta', credits: { total: 400_000, used: 380_000, remaining: 20_000, asOf } },
    { org: 'gamma', credits: { total: 400_000, used: 5, remaining: 399_995, asOf } },
  ], total: { total: 1_200_000, used: 505_005, remaining: 694_995, asOf } } })
  expect(f.calls.filter(call => call.method === 'POST').map(call => call.path).sort()).toEqual([
    '/api/v2/organizations/org-acme/usage_export_job', '/api/v2/organizations/org-beta/usage_export_job',
    '/api/v2/organizations/org-gamma/usage_export_job'])
})

it('reads CircleCI once per interval and applies a saved per-organization allowance without another read', async () => {
  const f = circle()
  await f.settledReading()
  const requests = f.calls.length
  f.allowance.accounts = { BETA: 500_000 }
  f.clock.now += 9 * 60_000
  const reading = await f.credits.reading()
  expect(reading.credits?.orgs.map(org => org.credits?.total)).toEqual([400_000, 500_000, 400_000])
  expect(reading.credits?.orgs[1]?.credits?.remaining).toBe(120_000)
  expect(f.calls).toHaveLength(requests)
  f.clock.now += 2 * 60_000
  await f.credits.reading()
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(6)
})

it('shows an organization whose usage cannot be read as unavailable instead of a wrong number', async () => {
  const f = circle({ failed: ['org-beta'] })
  const reading = await f.settledReading()
  expect(reading.credits?.orgs.map(org => org.org)).toEqual(['acme', 'beta', 'gamma'])
  expect(reading.credits?.orgs[1]).toEqual({ org: 'beta', credits: null, unavailable: 'CircleCI usage export failed: query failed' })
  expect(reading.credits?.orgs[0]?.credits).toMatchObject({ remaining: 275_000 })
  // The total counts only the readable organizations.
  expect(reading.credits?.total).toMatchObject({ total: 800_000, used: 125_005, remaining: 674_995 })
})

it('reports credits unavailable with the reason when the login is missing or has no GitHub organization', async () => {
  const loggedOut = circle({ token: null })
  expect(await loggedOut.settledReading()).toEqual({ credits: null, creditsUnavailable: 'CircleCI is not logged in on Main.' })
  const none = circle({ collaborations: [ORGS[3]] })
  expect((await none.settledReading()).creditsUnavailable).toContain('no GitHub organization')
})

it('drops a reading from an earlier month', async () => {
  const f = circle()
  expect((await f.settledReading()).credits?.total?.used).toBe(505_005)
  f.clock.now = Date.parse('2026-11-01T00:05:00Z')
  const reading = await f.credits.reading()
  expect(reading.credits?.total).toBeNull()
  expect(reading.credits?.orgs.every(org => org.credits === null)).toBe(true)
})

it('sums the TOTAL_CREDITS column whatever its capitalization, including quoted fields', () => {
  expect(sumTotalCredits(['a,"b, c",TOTAL_CREDITS', '1,"x ""y""",10.5', '2,z,3', ''].join('\n'))).toBe(13.5)
  expect(sumTotalCredits('a,total_credits\n1,7\n')).toBe(7)
})
