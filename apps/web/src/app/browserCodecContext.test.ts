import { expect, it } from 'vitest'
import { createBrowserHttp, type BrowserWireCodec } from '../features/agent-browser/http'

it('keeps each concurrent browser response bound to its original selection', async () => {
  const call = createBrowserHttp({ fetch: async () => new Response('{}', { status: 200 }),
    error: async () => ({ message: 'Unexpected HTTP failure' }) })
  const codec: BrowserWireCodec<[string], string> = {
    encode: selection => ({ json: { selection } }),
    decode: async (_response, args?: [string]) => args?.[0] ?? 'missing call context',
  }
  expect(await Promise.all([
    call('POST', '/api/browser/selection', codec, ['first']),
    call('POST', '/api/browser/selection', codec, ['second']),
  ])).toEqual(['first', 'second'])
})
