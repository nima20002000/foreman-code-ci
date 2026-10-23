import { BrowserOperationResponseSchemas, type BrowserSession } from '@foreman-code/contracts'
import { apiClient, ApiError } from '../shared/api/client'

const live = (session: BrowserSession) => session.state !== 'closed' && session.state !== 'failed'

/** Every live browser session on these computers, read one computer at a time. */
export async function readLiveBrowserSessions(computers: readonly { id: string; name: string }[], signal: AbortSignal) {
  const sessions: BrowserSession[] = [], unreachable: string[] = []
  let answered = 0, failure: unknown
  await Promise.all(computers.map(async computer => {
    try {
      let cursor: string | null = null
      for (let page = 0; page < 20; page++) {
        const input: { computerId: string; limit: number; live: true; cursor?: string } = { computerId: computer.id, limit: 100, live: true, ...(cursor ? { cursor } : {}) }
        const result: { sessions: BrowserSession[]; nextCursor: string | null } = await apiClient.request(`/api/browser/sessions?${new URLSearchParams({ input: JSON.stringify(input) })}`,
          BrowserOperationResponseSchemas.browser_sessions_list, { signal })
        sessions.push(...result.sessions.filter(live))
        cursor = result.nextCursor
        if (!cursor) break
      }
      answered++
    } catch (error) {
      if (signal.aborted) throw error
      // A computer that is offline, outdated or failing hides only its own browsers, never the other computers'.
      unreachable.push(computer.name)
      if (!ApiError.is(error) || error.code !== 'BROWSER_COMPUTER_OFFLINE') failure ??= error
    }
  }))
  // With no computer answering, keep the last good list on screen and show why.
  if (!answered && failure) throw failure
  return { sessions, unreachable }
}
