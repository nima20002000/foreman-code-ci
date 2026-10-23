import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { BrowserSession } from '@foreman-code/contracts'
import { server } from '../mocks/server'
import { readLiveBrowserSessions } from './liveBrowserSessions'

const session: BrowserSession = { id: 'session-main', setupForProfileId: 'profile', profileId: 'profile', computerId: 'main',
  browserGeneration: 1, state: 'ready', selectedTabId: null }
afterEach(() => server.resetHandlers())

it('still shows Main\'s browsers when a paired computer cannot answer', async () => {
  server.use(http.get('*/api/browser/sessions', ({ request }) => {
    const input = JSON.parse(new URL(request.url).searchParams.get('input')!) as { computerId: string }
    return input.computerId === 'main' ? HttpResponse.json({ sessions: [session], nextCursor: null })
      : HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'The API could not complete the request.' } }, { status: 500 })
  }))
  const result = await readLiveBrowserSessions([{ id: 'main', name: 'Main' }, { id: 'laptop', name: 'Laptop' }], new AbortController().signal)
  expect(result.sessions.map(item => item.id)).toEqual(['session-main'])
  expect(result.unreachable).toEqual(['Laptop'])
})

it('keeps failing when no computer could answer, so the last good list stays on screen', async () => {
  server.use(http.get('*/api/browser/sessions', () =>
    HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'The API could not complete the request.' } }, { status: 500 })))
  await expect(readLiveBrowserSessions([{ id: 'main', name: 'Main' }], new AbortController().signal)).rejects.toThrow()
})
