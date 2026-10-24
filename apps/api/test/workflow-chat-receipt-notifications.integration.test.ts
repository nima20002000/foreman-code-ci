import { expect, it } from 'vitest'
import { createProductionChatDelivery } from '../src/modules/collaboration/chatDeliveryProduction.js'
import { createWorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatProduction.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'

it('retains later Run receipt changes in the shared direct delivery journal after adoption', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const agentRepository = new PostgresAgentChatRepository(f.db.pool)
  const messages = new PostgresOperatorConversationRepository(f.db.pool)
  const unavailable = () => { throw new Error('No standalone native session is needed') }
  const agent = new AgentChatService(f.db.pool, agentRepository, messages, f.workflows, f.runs, unavailable, f.db.directory)
  const operator = new OperatorChatService(messages, new PostgresOperatorRepository(f.db.pool), unavailable, f.db.directory,
    new PostgresOperatorChatAuthority(f.db.pool, f.access, new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }),
      f.db.directory, `${f.address}/mcp`))
  const execution = createWorkflowExecutionChatService(f.db.pool, f.native)
  const feature = createProductionChatDelivery({ pool: f.db.pool, agent, operator, execution,
    bindConversationScope: async () => { throw new Error('No conversation rebind is needed') } })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'builder')
    const receipt = await feature.router.send(f.writer.principal, { commandId: 'queued-direct-input',
      target, intent: 'next_turn', content: 'Address this next' })
    expect(await feature.repository.pending()).toEqual([])
    const before = await feature.repository.targetRevision(target)
    await execution.cancel(f.writer.principal, { target, commandId: 'cancel-adopted-input', selection: { kind: 'one', receiptId: receipt.id } })
    expect(await feature.repository.targetRevision(target)).toBeGreaterThan(before)
    expect(await feature.router.read(f.writer.principal, { target, receiptId: receipt.id })).toMatchObject({
      receipts: [{ id: receipt.id, state: 'canceled' }],
    })
  } finally {
    provider.releaseAll(); await f.stop(); await drive
    await agent.shutdown(); await operator.shutdown(); await f.close()
  }
}, 60_000)
