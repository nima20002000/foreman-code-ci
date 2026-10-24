import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { migratedDatabase } from './migratedDatabase.js'

export async function operatorRepositoryFixture() {
  const db = await migratedDatabase()
  try {
    const owner = (await new PostgresAccessService(db.pool).issue({ name: 'Repository owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })).principal
    const { operator, configuration } = await new PostgresOperatorRepository(db.pool).ensure()
    const repository = new PostgresOperatorConversationRepository(db.pool)
    const conversation = await repository.create(operator.id, configuration, owner.id)
    const requestId = 'request'
    await repository.beginTurn(conversation.id, { requestId, content: 'Original input' }, owner.id)
    return { db, owner, repository, conversation, requestId, close: () => db.close() }
  } catch (error) { await db.close(); throw error }
}
