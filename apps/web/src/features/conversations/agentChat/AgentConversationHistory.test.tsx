import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { fixture } from '../../file-cards/testFixtures'
import { AgentConversationHistory } from './AgentConversationHistory'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

it('keeps attachment-only previous messages downloadable from their original conversation', async () => {
  const previous = structuredClone(agentChatFixtures.idleAfterCompletion)
  const { workspaceId, workflowId, agentId } = previous.context
  const conversationId = previous.conversation!.id
  const file = fixture({ filename: 'previous-notes.md', scope: { kind: 'temporary', chat: {
    kind: 'agent', workspaceId, workflowId, agentId, conversationId,
  } } })
  const message = { id: 'previous-file-message', conversationId, role: 'user' as const, content: '', attachments: [file] }
  const path = `/api/workspaces/${workspaceId}/agent-chat/conversations/${conversationId}`
  const downloads: string[] = []
  server.use(
    http.get(path, () => HttpResponse.json(previous)),
    http.get(`${path}/history`, () => HttpResponse.json({ conversationId, messages: [message], nextCursor: null })),
    http.get(`${path}/files/:fileId/revisions/:revisionId/content`, ({ request }) => {
      downloads.push(new URL(request.url).pathname)
      return HttpResponse.json({ error: { code: 'FILE_UNAVAILABLE', message: 'Download recorded.' } }, { status: 404 })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><AgentConversationHistory workspaceId={workspaceId}
    conversationId={conversationId} name="Coder" /></QueryClientProvider>)
  fireEvent.click(screen.getByText('Previous conversation'))
  const files = within(await screen.findByRole('list', { name: 'Message files' }))
  expect(files.getByText('previous-notes.md')).toBeVisible()
  fireEvent.click(files.getByRole('button', { name: 'Download previous-notes.md' }))
  await waitFor(() => expect(downloads).toEqual([`${path}/files/${file.revision.fileId}/revisions/${file.revision.revisionId}/content`]))
})
