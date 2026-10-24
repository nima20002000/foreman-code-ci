import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, AgentSchema, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { AgentCreateInputSchema, AgentUpdateInputSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { configurationInput, saveAgentConfiguration } from '../src/modules/workspaces/agentConfiguration.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { acceptOperatorConfiguration } from '../src/modules/conversations/operatorAcceptedConfiguration.js'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

const mainId = randomUUID()
const selection = { instanceId: randomUUID(), instanceRevision: '3', target: { hostRef: { kind: 'main' as const, mainId },
  applicationInstallationId: mainId, harnessInstallationId: 'codex-install', installationFingerprint: 'actual-install' } }
const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null, expiresAt: '9999-01-01T00:00:00.000Z', grants: [{ actions: ['harnesses:read'], scope: {} }] }
const configuration = DEFAULT_HARNESS_DEFAULTS.codex
let db: Awaited<ReturnType<typeof migratedDatabase>>
let commands: PostgresCommandCoordinator
let settings: PostgresFoundationSettingsRepository
beforeEach(async () => {
  db = await migratedDatabase()
  commands = new PostgresCommandCoordinator(db.pool)
  settings = new PostgresFoundationSettingsRepository(db.pool)
  await db.pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
    values($1,$2,'operator',$3,$4::jsonb,$5)`, [principal.id, principal.name,
    createHash('sha256').update(principal.id).digest('hex'), JSON.stringify([{ actions: ManagementActionSchema.options, scope: {} }]), principal.expiresAt])
  await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', ['workspace', JSON.stringify({ id: 'workspace', name: 'Profiles' })])
  await settings.updateAgentDefaults(DEFAULT_AGENT_DEFAULTS, undefined)
})
afterEach(async () => { await db?.close() })
const versions = async () => (await db.pool.query('select record from agent_configuration_versions order by version')).rows.map(row => row.record)
const revoke = async () => { await db.pool.query('update management_principals set revoked_at=now() where id=$1', [principal.id]) }

function selectionService() {
  const value: HostHarnessOverride = { ...selection, revision: 3, presetId: 'preset', enabled: true, driverId: 'codex', configuration: withAdvancedDefaults(configuration),
    configurationFingerprint: commandInputHash(withAdvancedDefaults(configuration)), qualification: 'unqualified' }
  const authorize = vi.fn(async () => {})
  const repository = { latest: vi.fn(async () => value), lockRevision: vi.fn(async () => {}) } as unknown as HarnessInstanceSettingsRepository
  const service = new HostHarnessOverrideService(repository, {} as PostgresCommandCoordinator, { authorize }, async () => null)
  return { value, authorize, repository, service }
}
describe('explicit chat profile configuration producer', () => {
  it('validates actual live host grant and exact current instance/config on the command client', async () => {
    const f = selectionService(); const client = {} as pg.PoolClient
    await f.service.validateSelection(principal, selection, configuration, client)
    expect(f.authorize).toHaveBeenCalledWith(principal, 'harnesses:read', selection.target.hostRef, mainId, client)
    expect(f.repository.latest).toHaveBeenCalledWith(client, selection.instanceId)
    for (const candidate of [{ ...selection, instanceRevision: '2' }, { ...selection, target: { ...selection.target, applicationInstallationId: randomUUID() } }]) {
      await expect(f.service.validateSelection(principal, candidate, configuration, client)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    }
    await expect(f.service.validateSelection(principal, selection, { ...configuration, model: 'changed' }, client)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    f.authorize.mockRejectedValue(new Error('revoked'))
    await expect(f.service.validateSelection(principal, selection, configuration, client)).rejects.toThrow('revoked')
  })
  it('strict MCP create/update schema retains the exact selector', () => {
    expect(AgentCreateInputSchema.parse({ workspaceId: 'w', commandId: 'command-create', agentId: 'a', name: 'A', configuration, harnessProfileSelection: selection }).harnessProfileSelection).toEqual(selection)
    expect(AgentUpdateInputSchema.parse({ workspaceId: 'w', commandId: 'command-update', agentId: 'a', expectedRevision: 1,
      expectedConfigurationVersionId: 'v1', harnessProfileSelection: selection }).harnessProfileSelection).toEqual(selection)
  })
  it('executes the actual MCP Agent create producer with authorized selected-profile validation and no API-host native probe', async () => {
    const creator = { ...principal, grants: [{
      actions: ['agents:create' as const, 'agents:read' as const, 'harnesses:read' as const], scope: {},
    }] }
    const execute = vi.fn(commands.execute.bind(commands))
    const qualifyConfiguration = vi.fn(async () => { throw new Error('local probe forbidden') })
    const validateSelection = vi.fn(async () => {})
    const service = new OperatorAgentMutationService(db.pool, { execute } as unknown as PostgresCommandCoordinator,
      { qualifyConfiguration } as never, { validateSelection })
    const input = { workspaceId: 'workspace', commandId: 'create-command', agentId: 'agent', name: 'A', configuration,
      productRole: 'coder' as const, harnessProfileSelection: selection }
    const saved = await service.create(creator, input)
    expect(saved.value).toMatchObject({ agent: { harnessProfileSelection: selection } })
    expect((await versions())[0]).toMatchObject({ harnessProfileSelection: selection })
    expect(validateSelection).toHaveBeenCalledWith(creator, selection, expect.objectContaining({ harness: 'codex' }), expect.anything())
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ source: 'mcp', operation: 'agent.create' }))
    expect(qualifyConfiguration).not.toHaveBeenCalled()
    validateSelection.mockRejectedValue(new Error('revoked host'))
    await expect(service.create(creator, { ...input, commandId: 'denied-command', agentId: 'denied' })).rejects.toThrow('revoked host')
    expect(await versions()).toHaveLength(1)
    await revoke()
    await expect(service.create(creator, { ...input, commandId: 'revoked-command', agentId: 'revoked' }))
      .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(await versions()).toHaveLength(1)
  })
  it('stores and reads profile metadata in the actual immutable Agent record and includes it in content hash', async () => {
    const input = AgentSchema.parse({ id: 'agent', name: 'A', harnessConfiguration: configuration, harnessProfileSelection: selection })
    const validate = vi.fn(async () => {})
    const saved = await withTransaction(db.pool, client => saveAgentConfiguration(client, 'workspace', input, false, validate))
    expect(saved.harnessProfileSelection).toEqual(selection)
    expect(AgentConfigurationVersionSchema.parse((await versions())[0]).harnessProfileSelection).toEqual(selection)
    expect(AgentSchema.parse((await db.pool.query('select record from agents where id=$1', [saved.id])).rows[0].record).harnessProfileSelection).toEqual(selection)
    expect(validate).toHaveBeenCalledWith(selection, expect.objectContaining({ harness: 'codex' }), expect.anything())
    const without = configurationInput('workspace', { id: 'agent', name: 'A', harnessConfiguration: configuration })
    expect(without.harnessProfileSelection).toBeUndefined()
    expect(configurationInput('workspace', input).harnessProfileSelection).toEqual(selection)
    await expect(withTransaction(db.pool, client => saveAgentConfiguration(client, 'workspace', saved))).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_UNAVAILABLE' })
  })
  it('validates and persists selected role defaults through the shared management command without local qualification', async () => {
    const writer = { ...principal, grants: [{ actions: ['settings:update' as const, 'harnesses:read' as const], scope: {} }] }
    const value = { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harnessProfileSelection: selection } }
    const qualifyConfiguration = vi.fn(async () => { throw new Error('unexpected local probe') })
    const validateSelection = vi.fn(async () => {})
    const service = new FoundationSettingsManagementService(settings, commands, { qualifyConfiguration } as never, undefined, { validateSelection })
    const result = await service.updateAgentDefaults(writer, 'mcp', { commandId: 'command-default', expectedRevision: 1, value })
    expect(result.value).toMatchObject({ value: { operator: { harnessProfileSelection: selection } } })
    expect(validateSelection).toHaveBeenCalledWith(writer, selection, value.operator.harness, expect.anything())
    expect(qualifyConfiguration).not.toHaveBeenCalled()
    validateSelection.mockRejectedValue(new Error('foreign installation'))
    await expect(service.updateAgentDefaults(writer, 'mcp', { commandId: 'command-denied', expectedRevision: 1, value })).rejects.toThrow('foreign installation')
    expect((await settings.getAgentDefaults()).revision).toBe(2)
    validateSelection.mockResolvedValue(undefined)
    await revoke()
    await expect(service.updateAgentDefaults(writer, 'mcp', {
      commandId: 'revoked-defaults', expectedRevision: 1, value,
    })).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect((await settings.getAgentDefaults()).revision).toBe(2)
  })
  it('publishes selected Operator defaults into the existing immutable record and inspection readback', async () => {
    const defaults = { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harnessProfileSelection: selection } }
    await settings.updateAgentDefaults(defaults, 1)
    const repository = new PostgresOperatorRepository(db.pool)
    const created = await repository.ensure()
    expect(created.configuration.harnessProfileSelection).toEqual(selection)
    expect((await db.pool.query('select record from operator_configuration_versions where id=$1', [created.configuration.id])).rows[0].record).toMatchObject({ harnessProfileSelection: selection })
    const inspection = await repository.inspectionConfiguration()
    expect(inspection.harnessProfileSelection).toEqual(selection)
  })
  it('keeps accepted Operator metadata in per-message immutable settings and exact retries', async () => {
    await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harnessProfileSelection: selection } }, 1)
    const base = (await new PostgresOperatorRepository(db.pool).ensure()).configuration
    await expect(acceptOperatorConfiguration(db.pool, base, {} as never, undefined, { ...configuration, model: 'new-model' })).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    const accepted = await acceptOperatorConfiguration(db.pool, base, { settings: { harness: 'codex', model: configuration.model, reasoningEffort: configuration.reasoningEffort, serviceTier: configuration.serviceTier, showThinking: !base.showThinking } } as never, undefined)
    expect(accepted.harnessProfileSelection).toEqual(selection)
    expect((await db.pool.query('select record from operator_configuration_versions where id=$1', [accepted.id])).rows[0].record).toMatchObject({ harnessProfileSelection: selection })
    expect(accepted.contentHash).not.toBe(base.contentHash)
    const retry = await acceptOperatorConfiguration(db.pool, base, {} as never, { operator_configuration_version_id: base.id })
    expect(retry.harnessProfileSelection).toEqual(selection)
  })
})


it('retains a saved selection across qualified installation replacements on the same host and configuration', async () => {
  const f = selectionService()
  const client = {} as pg.PoolClient
  const replacement = { ...f.value.target, harnessInstallationId: 'replacement', installationFingerprint: 'updated' }
  f.value.target = replacement
  let qualified = true
  const service = new HostHarnessOverrideService(f.repository, {} as PostgresCommandCoordinator,
    { authorize: f.authorize }, async value => ({ target: value.target,
      configurationFingerprint: value.configurationFingerprint, qualified }))
  await expect(service.validateSelection(principal, selection, configuration, client)).resolves.toBeUndefined()
  qualified = false
  await expect(service.validateSelection(principal, selection, configuration, client))
    .rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
  qualified = true
  f.value.instanceRevision = '4'
  await expect(service.validateSelection(principal, selection, configuration, client))
    .rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
})

it('saves a changed role while retaining an unchanged default on a revoked computer', async () => {
  const writer: ManagementPrincipal = { ...principal, grants: [{ actions: ['settings:update', 'settings:read',
    'harnesses:read'], scope: {} }] }
  const original = { ...DEFAULT_AGENT_DEFAULTS, coder: { ...DEFAULT_AGENT_DEFAULTS.coder, harnessProfileSelection: selection } }
  await settings.updateAgentDefaults(original, 1)
  const profiles = { validateSelection: async () => { throw new Error('Computer revoked') } }
  const accounts = { resolve: async (harness: unknown, selected: unknown) => {
    if (selected) throw new Error('Computer revoked')
    return harness
  } }
  const service = new FoundationSettingsManagementService(settings, commands, undefined, undefined, profiles,
    accounts as never)
  const value = { ...original, operator: { ...original.operator, showThinking: true } }
  await expect(service.updateAgentDefaults(writer, 'mcp', { commandId: 'thinking', value }))
    .resolves.toMatchObject({ value: { value } })
  expect(await service.getAgentDefaults(writer)).toMatchObject({ value, revision: 3 })
  await expect(service.updateAgentDefaults(writer, 'mcp', { commandId: 'model',
    value: { ...value, coder: { ...value.coder, harness: { ...value.coder.harness, model: 'changed' } } } }))
    .rejects.toThrow('Computer revoked')
  expect((await service.getAgentDefaults(writer)).revision).toBe(3)
  await expect(async () => service.updateAgentDefaults({ ...writer, grants: [] }, 'mcp', { commandId: 'denied', value }))
    .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
})

describe('local Claude profile reuse', () => {
  it('reuses a qualified exact profile while a re-check of it is running', async () => {
    const claude: ClaudeHarnessConfiguration = { harness: 'claude', model: 'claude-test', authMode: 'subscription',
      configDirectory: '/recorded/claude', permissionMode: 'default', sandbox: 'read-only', tools: [], permissionRules: [],
      instructions: '', mcpServers: {} }
    const value: HostHarnessOverride = { ...selection, revision: 3, presetId: 'preset', enabled: true, driverId: 'claude', configuration: claude,
      configurationFingerprint: commandInputHash(claude), qualification: 'unqualified' }
    const repository = { list: vi.fn(async () => [value]), latest: vi.fn(async () => value), lockRevision: vi.fn(async () => {}) } as unknown as HarnessInstanceSettingsRepository
    const evidence = async () => ({ target: value.target, configurationFingerprint: value.configurationFingerprint, qualified: true }) as never
    const checks = { pending: () => true, failure: async () => undefined } as never
    const service = new HostHarnessOverrideService(repository, {} as PostgresCommandCoordinator, { authorize: async () => {} }, evidence, checks)
    await db.pool.query('update application_installation set id=$1', [mainId])
    await expect(withTransaction(db.pool, client => service.selectionForConfiguration(principal, claude, client))).resolves.toEqual(selection)
  })
})
