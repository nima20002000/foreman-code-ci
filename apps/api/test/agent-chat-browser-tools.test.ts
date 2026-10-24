import type pg from 'pg'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { BrowserOperationHandlers } from '../src/modules/browser-runtime/operations.js'
import { createBrowserCanonicalCodecs } from '../src/modules/collaboration/browserCodecs.js'
import { createGraphqlMcpServer } from '../src/mcp/unified/server.js'
import { workerToolServices } from './helpers/workerMcpServices.js'

const worker = (id: string): ManagementPrincipal => ({ id, name: id, audience: 'worker', agentId: 'agent-1',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] })
const tools = ['browser_tabs_list', 'browser_state_read']
const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())) })

function connect(principal: ManagementPrincipal) {
  const tabsList = vi.fn(async () => [])
  const handlers = { browser_tabs_list: tabsList } as unknown as BrowserOperationHandlers
  const commands = { recordDenied: async () => undefined }
  const chat = {
    isChat: async (caller: ManagementPrincipal) => caller.id === 'chat-caller',
    sessionFor: async (caller: ManagementPrincipal) => caller.id === 'chat-caller' ? 'chat-session' : undefined,
    agentActor: () => ({ kind: 'agent', browserGeneration: 1, epoch: 2 }),
  }
  const services = { commands, browser: { handlers, codecs: createBrowserCanonicalCodecs(), chat } } as unknown as OperatorServices
  const interactions = { canRead: async () => true, canRespond: async () => false } as unknown as AppInteractionService
  return createGraphqlMcpServer({ role: 'coder', principal, tools, operator: services, interactions,
    references: workerToolServices({} as pg.Pool, commands as never).references }).then(async server => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'browser-tools', version: '1' })
    clients.push(client)
    await client.connect(clientTransport)
    return { client, tabsList }
  })
}

const schemaOf = async (client: Client, name: string) =>
  (await client.listTools()).tools.find(tool => tool.name === name)!.inputSchema as { properties: Record<string, unknown>; required?: string[] }

describe('browser tools for an Agent chat and a Run Agent', () => {
  it('lists no session ID or required actor for an Agent chat and acts on its own browser', async () => {
    const { client, tabsList } = await connect(worker('chat-caller'))
    expect((await schemaOf(client, 'browser_tabs_list')).properties).not.toHaveProperty('sessionId')
    const state = await schemaOf(client, 'browser_state_read')
    expect(state.properties).not.toHaveProperty('sessionId')
    expect(state.required ?? []).not.toContain('actor')
    const result = await client.callTool({ name: 'browser_tabs_list', arguments: {} })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(tabsList).toHaveBeenCalledWith(expect.anything(), { sessionId: 'chat-session' })
  })

  it('keeps the session ID and actor in the tool schemas of a Run Agent', async () => {
    const { client, tabsList } = await connect(worker('run-caller'))
    expect((await schemaOf(client, 'browser_tabs_list')).required).toContain('sessionId')
    expect((await schemaOf(client, 'browser_state_read')).required).toEqual(expect.arrayContaining(['sessionId', 'actor']))
    const missing = await client.callTool({ name: 'browser_tabs_list', arguments: {} })
    expect(missing.isError).toBe(true)
    const result = await client.callTool({ name: 'browser_tabs_list', arguments: { sessionId: 'run-session' } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(tabsList).toHaveBeenCalledExactlyOnceWith(expect.anything(), { sessionId: 'run-session' })
  })
})
