import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { AgentSubject, BrowserSession } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { BrowserAuthority } from './browserAuthority.js'
import type { BrowserLifecyclePort } from './ports.js'
import { CHAT_BROWSER_IDLE_MS, ChatBrowserSessions } from './chatBrowser.js'

const agent = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const chatSubject = { kind: 'conversation', agent, conversationId: 'chat-1' } as Extract<AgentSubject, { kind: 'conversation' }>
const runSubject = { kind: 'execution', agent, execution: { runId: 'run', executionId: 'execution' } } as unknown as AgentSubject
const principal = { id: 'chat-principal', audience: 'worker' } as ManagementPrincipal

function fixture() {
  let clock = 0
  let active = true
  const open = new Map<string, BrowserSession>()
  const lifecycle = {
    prepare: vi.fn<BrowserLifecyclePort['prepare']>(async input => {
      const id = `session-${open.size + 1}`
      const session = { id, subject: input.subject, profileId: input.browser.profileId!, computerId: input.computerId,
        browserGeneration: 1, state: 'ready', selectedTabId: null } as BrowserSession
      open.set(id, session)
      return { kind: 'ready', session, control: {} } as Awaited<ReturnType<BrowserLifecyclePort['prepare']>>
    }),
    release: vi.fn<BrowserLifecyclePort['release']>(async input => {
      open.delete(input.sessionId)
      return { sessionId: input.sessionId, state: 'closed' } as Awaited<ReturnType<BrowserLifecyclePort['release']>>
    }),
  }
  const authority = { details: async (subject: AgentSubject) => ({ subject, active, computerId: 'main',
    browser: { enabled: true, profileId: 'profile' } }) } as unknown as BrowserAuthority
  const chats = new ChatBrowserSessions({ pool: {} as pg.Pool, authority, lifecycle,
    localSessions: async () => [...open.values()], chatSubject: async () => chatSubject, now: () => clock })
  return { chats, lifecycle, open, tick: (ms: number) => { clock += ms }, archive: () => { active = false } }
}

it('opens the chat its own browser on the Agent profile at the first browser call and reuses it', async () => {
  const f = fixture()
  const first = await f.chats.sessionFor(principal)
  expect(first).toBe('session-1')
  expect(f.lifecycle.prepare).toHaveBeenCalledWith(expect.objectContaining({ subject: chatSubject, computerId: 'main',
    browser: { enabled: true, profileId: 'profile' } }))
  expect(await f.chats.sessionFor(principal)).toBe(first)
  expect(f.open.size).toBe(1)
  expect(await f.chats.sessionFor({ id: 'operator', audience: 'operator' } as ManagementPrincipal)).toBeUndefined()
})

it('closes the chat browser when a Run needs its profile and tells the chat the browser is in use by a Run', async () => {
  const f = fixture()
  const chatSession = await f.chats.sessionFor(principal)
  await f.chats.yieldToRun('profile', 'main')
  expect(f.lifecycle.release).toHaveBeenCalledWith(expect.objectContaining({ sessionId: chatSession, reason: 'conversation_closed' }))
  const run = await f.lifecycle.prepare({ subject: runSubject, browser: { enabled: true, profileId: 'profile' }, computerId: 'main', commandId: 'run' })
  if (run.kind === 'ready') f.chats.runOpened(run.session)
  await expect(f.chats.sessionFor(principal)).rejects.toMatchObject({ code: 'BROWSER_IN_USE_BY_RUN',
    message: expect.stringContaining('in use by a Run') })
})

it('closes the chat browser after ten idle minutes and when the chat is archived', async () => {
  const f = fixture()
  await f.chats.sessionFor(principal)
  f.tick(CHAT_BROWSER_IDLE_MS - 1000)
  await f.chats.sweep()
  expect(f.open.size).toBe(1)
  f.tick(1000)
  await f.chats.sweep()
  expect(f.open.size).toBe(0)

  await f.chats.sessionFor(principal)
  expect(f.open.size).toBe(1)
  f.archive()
  await f.chats.sweep()
  expect(f.open.size).toBe(0)
})
