import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema, ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { OPERATOR_TOOLS } from '../src/mcp/operator/catalog.js'
import { toolAvailable } from '../src/mcp/operator/definition.js'
import type { OperatorRequestContext, OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { operatorCatalogNames } from './support/operatorCatalog.js'

const principal = (id: string, grants: ManagementPrincipal['grants']): ManagementPrincipal =>
  ({ id, name: id, audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants })
const owner = principal('owner', [{ actions: [...ManagementActionSchema.options], scope: {} }])
const restricted = principal('restricted', [
  { actions: ['capabilities:read', 'settings:read', 'harnesses:read', 'provider_accounts:read'], scope: {} },
  { actions: ['workspaces:read', 'agents:read', 'runs:read', 'skills:read', 'bug_reports:read'], scope: { workspaceIds: ['workspace-a'] } },
])

/** Every service a registry tool can depend on is composed. Discovery never invokes these stubs. */
function services(recordDenied: OperatorServices['commands']['recordDenied']): OperatorServices {
  return {
    commands: { recordDenied, recordAudit: vi.fn(async () => undefined) },
    workspaces: { storageFolders: {} }, locations: {}, workflows: {}, agents: {}, harnesses: {}, runs: { subagents: {} },
    settings: {}, interactions: {}, bugReports: {}, providerAccounts: {}, remoteExecution: {}, workerExecution: {},
    resourceTelemetry: { reads: {}, selectors: {} }, workspaceRepositories: {}, workspaceRoots: {}, harnessRegistry: {},
    trustedConnections: {}, computerActivity: {}, computerAccounts: {}, computerMaintenance: {}, computerGitHub: {},
    computerSync: {}, buildComputers: {}, devices: {}, sources: {}, executionReadiness: {}, runPlacements: {},
    placementChoices: {}, operatorChat: {}, agentChat: {}, harnessCompatibility: {}, harnessQualifications: {},
    harnessSettings: { mcp: {}, directories: {}, plugins: {}, claudePlugins: {} },
    extensions: { native: {}, agents: {}, history: {}, lifecycle: {}, skills: {}, skillUsage: {},
      workspace: { provisioningEnabled: true } },
  } as unknown as OperatorServices
}

const clients: Client[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  for (const close of closers.splice(0)) await close()
})

async function endpoint(additionalCaller?: ManagementPrincipal) {
  const pool = new pg.Pool()
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Unexpected SQL') })
  const recordDenied = vi.fn(async () => undefined)
  const composed = services(recordDenied)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const caller = [owner, restricted, ...(additionalCaller ? [additionalCaller] : [])].find(candidate => candidate.id === token)
    if (!caller) throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return caller
  })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: composed } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  closers.push(async () => { await app.close(); await pool.end() })
  const connect = async (token: string) => {
    const client = new Client({ name: 'registry-discovery', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  return { composed, recordDenied, connect }
}

// tools/list shows only core tools, so the caller's whole catalog is read through discovery.
const listedNames = operatorCatalogNames

const registryNames = new Set<string>(OPERATOR_TOOLS.map(tool => tool.name))
const requirementsOf = (name: string) => OPERATOR_TOOLS.find(tool => tool.name === name)!.requires.map(([action]) => action)

/**
 * Every Operator turn sends the whole tools/list to the model, and 309 always-loaded tools once overflowed
 * Claude's context. This ceiling keeps the core list small.
 * TODO(integration agent): this value is an estimate. On the first run, set it to the measured size printed by
 * the failing assertion, rounded up to the next 1,000 characters, and delete this note.
 */
const LISTED_TOOLS_CEILING_CHARACTERS = 40_000

describe('Operator MCP tool registry', () => {
  it('has one definition per tool name', () => {
    expect(registryNames.size).toBe(OPERATOR_TOOLS.length)
  })

  it('keeps the tools/list an unrestricted caller receives under its size ceiling and leaves rare tools to discovery', async () => {
    const f = await endpoint()
    const client = await f.connect(owner.id)
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['workspace_list', 'run_start', 'tools_find', 'tool_schema', 'tool_run']))
    for (const rare of ['workflow_create', 'agent_defaults_get', 'workflow_kanban_layout_get', 'operator_tool_schema_get']) {
      expect(names).not.toContain(rare)
    }
    expect(JSON.stringify(tools).length).toBeLessThan(LISTED_TOOLS_CEILING_CHARACTERS)
    // Tools left out of tools/list stay reachable by name through discovery.
    const reachable = await listedNames(client)
    expect(reachable).toEqual(expect.arrayContaining(['workflow_create', 'agent_defaults_get']))
    const schema = decodeMcpToolResult(await client.callTool({ name: 'tool_schema', arguments: { name: 'workflow_create' } })) as {
      name: string; permissionRequirements?: { actions?: string[] } }
    expect(schema.name).toBe('workflow_create')
    expect(schema.permissionRequirements?.actions).toEqual(requirementsOf('workflow_create'))
  })

  it.each([['unrestricted', owner], ['restricted', restricted]] as const)(
    'discovers exactly the registry tools and permission requirements for the %s caller', async (_label, caller) => {
      const f = await endpoint()
      const client = await f.connect(caller.id)
      const context = { principal: caller, services: f.composed } as OperatorRequestContext
      const expected = OPERATOR_TOOLS.filter(tool => toolAvailable(context, tool)).map(tool => tool.name).sort()
      expect(expected.length).toBeGreaterThan(0)

      const listed = (await listedNames(client)).filter(name => registryNames.has(name)).sort()
      expect(listed).toEqual(expected)

      const capabilities = decodeMcpToolResult(await client.callTool({
        name: 'operator_get_capabilities', arguments: { detail: 'full' } })) as {
        tools: string[]; requirements: Array<{ name: string; actions: string[] }> }
      expect(capabilities.tools.filter(name => registryNames.has(name)).sort()).toEqual(expected)
      const requirements = capabilities.requirements.filter(entry => registryNames.has(entry.name))
      expect(requirements.map(entry => entry.name).sort()).toEqual(expected)
      for (const entry of requirements) expect(entry.actions).toEqual(requirementsOf(entry.name))
    })

  it('limits the restricted caller to its grants and reports each tool’s registry requirements', async () => {
    const f = await endpoint()
    const client = await f.connect(restricted.id)
    const listed = new Set(await listedNames(client))
    for (const name of ['general_settings_get', 'harness_list', 'provider_accounts_list', 'run_list', 'agent_get', 'skill_create']) {
      expect(listed).toContain(name)
    }
    for (const name of ['general_settings_update', 'harness_defaults_update', 'provider_account_create', 'run_start',
      'workspace_create', 'device_revoke', 'bug_reports_close']) {
      expect(listed).not.toContain(name)
    }
    for (const name of [...listed].filter(name => registryNames.has(name))) {
      const schema = decodeMcpToolResult(await client.callTool({ name: 'tool_schema', arguments: { name } })) as {
        name: string; permissionRequirements: { actions?: string[] } }
      expect(schema.name).toBe(name)
      expect(schema.permissionRequirements.actions).toEqual(requirementsOf(name))
    }
  })

  it('denies and audits a direct call to a tool hidden from the restricted caller', async () => {
    const f = await endpoint()
    const client = await f.connect(restricted.id)
    const denied = await client.callTool({ name: 'device_revoke', arguments: {} })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(f.recordDenied).toHaveBeenCalledWith(restricted.id, 'mcp', 'device_revoke', 'mcp:device_revoke')
  })
})

const scopeDimensions = ['workspaceIds', 'workflowIds', 'runIds', 'mainIds', 'deviceIds',
  'applicationInstallationIds', 'providerAccountIds'] as const

it.each(scopeDimensions)('hides global harness options from a %s scoped authenticated caller', async dimension => {
  const caller = principal(`scoped-${dimension}`, [
    { actions: ['capabilities:read'], scope: {} },
    { actions: ['harnesses:read'], scope: { [dimension]: [randomUUID()] } },
  ])
  expect(ManagementPrincipalSchema.safeParse(caller).success).toBe(true)
  const f = await endpoint(caller)
  const client = await f.connect(caller.id)
  expect(await listedNames(client)).not.toContain('harness_options_get')
  const capabilities = decodeMcpToolResult(await client.callTool({
    name: 'operator_get_capabilities', arguments: { detail: 'full' },
  })) as { tools: string[] }
  expect(capabilities.tools).not.toContain('harness_options_get')
  const denied = await client.callTool({ name: 'harness_options_get', arguments: { harness: 'codex' } })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
})

it('hides global tools for combined host and account constraints but keeps the unscoped positive control', async () => {
  const caller = principal('combined', [{ actions: ['harnesses:read'],
    scope: { deviceIds: [randomUUID()], mainIds: [randomUUID()], providerAccountIds: [randomUUID()] } }])
  expect(ManagementPrincipalSchema.safeParse(caller).success).toBe(true)
  const f = await endpoint(caller)
  expect(await listedNames(await f.connect(caller.id))).not.toContain('harness_options_get')
  expect(await listedNames(await f.connect(owner.id))).toContain('harness_options_get')
})
