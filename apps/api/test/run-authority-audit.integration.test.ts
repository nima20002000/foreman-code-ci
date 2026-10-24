import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, it, vi } from 'vitest'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import type pg from 'pg'
import type { DurableInteraction } from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { DomainError } from '../src/modules/errors.js'
import { acceptRunAuthority, bindRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import type { InteractionService } from '../src/modules/interactions/service.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'

function interaction(): DurableInteraction {
  return { id: 'interaction-proof', revision: 0, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'coder', harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: 'run', request: { command: 'test' },
    approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' },
    responseOptions: [{ optionId: 'choice', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' }
}
const principal = () => ManagementPrincipalSchema.parse({ id: 'worker', name: 'Reviewer', audience: 'worker', agentId: 'reviewer',
  grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }],
  expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null })

for (const revoked of [true, false]) it(`F03: App response forwards exact worker authority to the current decision writer; revoked=${revoked}`, async () => {
  const record = interaction(), actor = principal()
  const recordAudit = vi.fn(async () => undefined)
  const commands = { recordAudit, recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const respond: InteractionService['respond'] = async (responder, input) => {
    assert.equal(responder.kind, 'orchestrator')
    assert.equal(responder.principal, actor)
    assert(!('beforeCommit' in responder), 'raw audit callbacks cannot join the current G1 decision transaction')
    if (responder.kind === 'orchestrator') assert.deepEqual(responder.authority,
      { agentId: actor.agentId, workspaceId: record.workspaceId, workflowId: record.workflowId })
    assert.deepEqual(input, { interactionId: record.id, optionId: 'choice', expectedRevision: 0 })
    if (revoked) throw new DomainError('AUTH_REVOKED', 'The live binding was revoked before commit.', 401)
    return { interaction: { ...record, revision: 1, selectedOptionId: 'choice', selectedSemantic: 'approve_once', nativeResponse: null,
      decidedAt: '2026-09-16T00:00:01.000Z', status: 'delivery_pending', deliveryState: 'pending' }, replayed: false }
  }
  const repository = { get: async () => structuredClone(record) } as unknown as PostgresInteractionRepository
  const app = new PostgresAppInteractionService({} as pg.Pool, repository, commands, { respond })
  const action = app.respond(actor, { interactionId: record.id, optionId: 'choice', expectedRevision: 0 })
  if (revoked) {
    await assert.rejects(action, (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
    assert.equal(record.selectedOptionId, undefined)
    assert.equal((recordAudit.mock.calls[0] as unknown[])[4], 'failed')
  } else {
    assert.equal((await action).interaction.selectedOptionId, 'choice')
    assert.equal(recordAudit.mock.calls.length, 0, 'the decision writer owns the successful transactional audit')
  }
})

let current: Awaited<ReturnType<typeof migratedDatabase>> | undefined
afterEach(async () => { await current?.close(); current = undefined })
async function authorityDatabase() {
  const database = current = await migratedDatabase()
  const fixture = await seedWorkflowFixture(database.pool, database.directory)
  const expires = new Date(Date.now() + 3_600_000)
  const caller = ManagementPrincipalSchema.parse({ id: 'chat', name: 'Chat transport', audience: 'operator',
    grants: [{ actions: ['runs:start', 'workspace_locations:read'], scope: { workspaceIds: [fixture.scope.workspaceId] } }],
    expiresAt: expires.toISOString(), revokedAt: null })
  for (const [id, name, delegatedFrom, grants] of [
    ['owner', 'Owner', null, [{ actions: ['runs:start', 'workspace_locations:read', 'operator_chat:write'], scope: { workspaceIds: [fixture.scope.workspaceId] } }]],
    [caller.id, caller.name, 'owner', caller.grants],
  ] as const) await database.pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at,delegated_from)
    values($1,$2,'operator',$3,$4::jsonb,$5,$6)`, [id,name,createHash('sha256').update(id).digest('hex'),JSON.stringify(grants),expires,delegatedFrom])
  const bind = async (accepted: Awaited<ReturnType<typeof acceptRunAuthority>>) => withTransaction(database.pool, async client => {
    await client.query("update runs set record=jsonb_set(record,'{authorizationPrincipalId}',to_jsonb($2::text)) where id=$1", [fixture.run.id,accepted.principal.id])
    await bindRunAuthority(client,fixture.run.id,accepted)
  })
  const revoke = async (id: string) => { await database.pool.query('update management_principals set revoked_at=now() where id=$1',[id]) }
  const expire = async (id: string, at: number) => { await database.pool.query('update management_principals set expires_at=$2 where id=$1',[id,new Date(at)]) }
  return { db: database.pool, caller, bind, revoke, expire, workspaceId: fixture.scope.workspaceId }
}

it('F04: chat release cannot revoke the Run snapshot, but human-owner revocation still can', async () => {
  const h = await authorityDatabase()
  const accepted = await withTransaction(h.db, client => acceptRunAuthority(client, h.caller))
  assert.equal(accepted.callerId, 'chat')
  assert.equal(accepted.ownerId, 'owner')
  await h.bind(accepted)
  await h.revoke('chat')
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert.equal(current.owner.id, 'owner')
  assert(current.principal.grants.some((grant) => grant.actions.includes('runs:start')))
  await h.revoke('owner')
  await assert.rejects(currentOperatorAuthority(h.db, accepted.principal.id), (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
})

it('F04: both the accepted grant ceiling and the owner’s current narrower permissions apply', async () => {
  const h = await authorityDatabase()
  const accepted = await withTransaction(h.db, client => acceptRunAuthority(client, h.caller))
  await h.bind(accepted)
  await h.db.query('update management_principals set grants=$2::jsonb where id=$1', ['owner', JSON.stringify([{ actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: [h.workspaceId, 'another'] } }])])
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert(!current.principal.grants.some((grant) => grant.actions.includes('workspace_locations:read') || grant.actions.includes('runs:stop')))
  assert(current.principal.grants.every((grant) => !grant.scope.workspaceIds?.includes('another')))
  assert(Date.parse(current.principal.expiresAt) <= Date.parse(accepted.principal.expiresAt))
})

it('F04: an ordinary delegated chat principal is not accepted as durable Run authority', async () => {
  const h = await authorityDatabase()
  await assert.rejects(currentOperatorAuthority(h.db, 'chat'), (error: unknown) => error instanceof DomainError && error.code === 'AUTH_INVALID')
})


it('an accepted Run survives expiry of the chat token that started it', async () => {
  const h = await authorityDatabase()
  const tokenExpiry = Date.now() + 60_000
  await h.expire('chat', tokenExpiry)
  h.caller.expiresAt = new Date(tokenExpiry).toISOString()
  const accepted = await withTransaction(h.db, client => acceptRunAuthority(client, h.caller))
  await h.bind(accepted)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(tokenExpiry + 1)
  try {
    const current = await currentOperatorAuthority(h.db, accepted.principal.id)
    assert(current.principal.grants.some(grant => grant.actions.includes('runs:start')))
    assert(Date.parse(current.principal.expiresAt) > Date.now())
  } finally {
    clock.mockRestore()
  }
})

it('an accepted Run survives root starter expiry while retaining owner revocation', async () => {
  const h = await authorityDatabase()
  const owner = await currentOperatorAuthority(h.db, 'owner')
  const accepted = await withTransaction(h.db, client => acceptRunAuthority(client, owner.principal))
  await h.bind(accepted)
  await h.expire('owner', Date.now() - 1)
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert.equal(current.owner.id, 'owner')
  await assert.rejects(currentOperatorAuthority(h.db, 'owner'),
    (error: unknown) => error instanceof DomainError && error.code === 'AUTH_EXPIRED')
  await h.revoke('owner')
  await assert.rejects(currentOperatorAuthority(h.db, accepted.principal.id),
    (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
  await assert.rejects(currentOperatorAuthority(h.db, 'owner'),
    (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
})
