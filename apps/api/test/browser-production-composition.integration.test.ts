import WebSocket from 'ws'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createBrowserProfileRepository } from '../src/modules/browser-profiles/repository.js'
import { access, address, database, production, registerProductionLifecycleFixture } from './helpers/productionLifecycleFixture.js'

registerProductionLifecycleFixture()

it('registers browser profile persistence in the application migration chain', async () => {
  const repository = createBrowserProfileRepository(database.pool)
  await expect(repository.read(tx => tx.catalogRevision())).resolves.toBe(0)
})

it('exposes the production browser catalog over authenticated HTTP and MCP with denied callers', async () => {
  const owner = await access.issue({ name: 'Browser profile owner', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update', 'agent_chat:read', 'agent_chat:write', 'capabilities:read'], scope: {} }] })
  const reader = new Client({ name: 'Browser composition client', version: '1' })
  const denied = new Client({ name: 'Denied browser client', version: '1' })
  try {
    await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => owner.token },
    }))
    expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'browser_profiles_list', 'browser_profile_create', 'browser_sessions_list', 'browser_view_open', 'browser_control_release',
    ]))
    const listed = await reader.callTool({ name: 'browser_profiles_list', arguments: {} })
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true)
    expect(decodeMcpToolResult(listed)).toMatchObject({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [] })
    const http = await production.app.inject({ url: '/api/browser/profiles',
      headers: { authorization: `Bearer ${owner.token}` } })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.json()).toEqual(decodeMcpToolResult(listed))
    const stranger = await access.issue({ name: 'Unrelated browser caller', audience: 'operator',
      grants: [{ actions: ['workspaces:read'], scope: {} }] })
    await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => stranger.token },
    }))
    expect((await denied.callTool({ name: 'browser_profiles_list', arguments: {} })).isError).toBe(true)
  } finally {
    await denied.close()
    await reader.close()
  }
})

it('mounts the browser viewer channel and rejects stale installation handshakes', async () => {
  const owner = await access.issue({ name: 'Browser viewer', audience: 'operator',
    grants: [{ actions: ['settings:read'], scope: {} }] })
  const url = new URL('/api/browser/sessions/unknown/view', address); url.protocol = 'ws:'
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${owner.token}` } })
  try {
    const code = await new Promise<number>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('open', () => socket.send(JSON.stringify({ viewId: 'unknown', installationId: 'stale-installation' })))
      socket.once('close', resolve)
    })
    expect(code).toBe(1008)
  } finally { socket.terminate() }
})
