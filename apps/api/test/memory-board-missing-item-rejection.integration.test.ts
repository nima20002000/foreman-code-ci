import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { MemoryBoardService } from '../src/modules/memory-boards/service.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('Memory board commands naming a missing item', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  const principal: ManagementPrincipal = {
    id: 'missing-item-operator', name: 'Missing Item Operator', audience: 'operator',
    grants: [{ actions: ['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update'], scope: {} }],
    expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null,
  }
  beforeAll(async () => {
    database = await migratedDatabase()
    await withTransaction(database.pool, async tx => {
      await tx.query('create table memory_test_owner(id text primary key,record jsonb not null)')
      await tx.query('create table memory_test_facts(id text primary key,record jsonb not null)')
    })
  }, 60000)
  afterAll(async () => { await database?.close() })

  async function setup() {
    const fixture = memoryFixture(database.pool, principal)
    const service = new MemoryBoardService({ authority: fixture.authority, transaction: fixture.transaction,
      readTransaction: fixture.transaction, listen: async () => () => undefined })
    return { service, boardId: (await fixture.snapshot()).board.id }
  }

  it('records a card update for a missing card as rejected, not unknown', async () => {
    const { service, boardId } = await setup()
    const commandId = randomUUID()
    await expect(service.mutate(principal, { kind: 'card_update', boardId, commandId, cardId: randomUUID(),
      patch: { title: 'Renamed' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await service.read(principal, { boardId, view: 'command', commandId })).toMatchObject({
      commandId, state: 'rejected', error: { code: 'NOT_FOUND' } })
  })

  it('records a note update for a missing note as rejected, not unknown', async () => {
    const { service, boardId } = await setup()
    const commandId = randomUUID()
    await expect(service.mutate(principal, { kind: 'note_update', boardId, commandId, noteId: randomUUID(),
      patch: { text: 'Edited' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await service.read(principal, { boardId, view: 'command', commandId })).toMatchObject({
      commandId, state: 'rejected', error: { code: 'NOT_FOUND' } })
  })
})
