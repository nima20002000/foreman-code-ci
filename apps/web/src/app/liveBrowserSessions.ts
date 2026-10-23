import { BrowserOperationResponseSchemas, type BrowserSession } from '@foreman-code/contracts'
import { apiClient, ApiError } from '../shared/api/client'

const live = (session: BrowserSession) => session.state !== 'closed' && session.state !== 'failed'

/** Every live browser session on these computers, read one computer at a time. */
export async function readLiveBrowserSessions(computers: readonly { id: string; name: string }[], signal: AbortSignal) {
  const sessions: BrowserSession[] = [], unreachable: string[] = []
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
    } catch (error) {
      // Only an offline computer is skipped; any other failure keeps the last good list and shows the error.
      if (signal.aborted || !ApiError.is(error) || error.code !== 'BROWSER_COMPUTER_OFFLINE') throw error
      unreachable.push(computer.name)
    }
  }))
  return { sessions, unreachable }
}
