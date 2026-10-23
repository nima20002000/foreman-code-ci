import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, ChatDeliveryReceiptSchema, EngineChatReadbackSchema,
  type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

/** The owner's saved shape: an Orchestrator connected to one Worker, no named routes, no hierarchy. */
function orchestratorWorkerFixture() {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map((config, index) => AgentConfigurationVersionSchema.parse({
    ...config, productRole: index === 0 ? 'orchestrator' : 'coder' }))
  fixture.version = { ...fixture.version, definition: { ...fixture.version.definition, handoffs: { contractVersion: 1 },
    executionPolicy: { maxParallelism: 2, maxNodeExecutions: 10 },
    nodes: fixture.version.definition.nodes.map((node, index) => ({ ...node, name: index === 0 ? 'Orchestrator' : 'Worker' })) } }
  return fixture
}

const output = (orchestrator: string) => (nodeId: string, request: HarnessExecutionRequest) => {
  const work = WorkActivationInputSchema.parse(request.input).work
  const routing = nodeId !== orchestrator || work.kind === 'entry' ? { kind: 'finish' as const }
    : { kind: 'return' as const, outcome: 'accepted' as const }
  return { routing, data: { latestDeliverable: { by: nodeId, work: work.kind }, remainingFindings: [] } }
}

describe.skipIf(!postgresEnabled)('owner chat with a workflow Agent during its Run', () => {
  it('delivers a message to a finished Orchestrator turn at its next turn in the same Run', async () => {
    const fixture = orchestratorWorkerFixture()
    const [orchestrator, worker] = fixture.version.definition.nodes.map((node) => node.id) as [string, string]
    const provider = new ControlledWorkflowProvider([orchestrator, worker], output(orchestrator))
    const f = await currentOperatorIntegration({ executionChat: true, fixture, approvalNodeIds: [], collaborationPorts: {},
      managerFactory: context => provider.connection(context) })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered(orchestrator)
      provider.release(orchestrator)
      await provider.entered(worker)
      // The Orchestrator handed its task over and is done for now; the owner writes to it while the Worker works.
      const target = await workflowChatTarget(f, orchestrator)
      const receipt = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', {
        commandId: 'owner-note', target, intent: 'next_turn', content: 'Also check the page title.', attachments: [] }))
      expect(receipt.state).toBe('queued')
      provider.release(worker)
      await expect.poll(() => provider.prompts.filter(item => item.nodeId === orchestrator).length,
        { timeout: 15_000 }).toBe(2)
      const [first, review] = provider.prompts.filter(item => item.nodeId === orchestrator)
      expect(first!.prompt).not.toContain('Also check the page title.')
      expect(review!.prompt).toContain('Also check the page title.')
      expect(provider.prompts.find(item => item.nodeId === worker)!.prompt).not.toContain('Also check the page title.')
      // The Worker is done too; a message to it that no later turn takes is closed with the Run, not left queued.
      const workerTarget = await workflowChatTarget(f, worker)
      expect(ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', {
        commandId: 'late-note', target: workerTarget, intent: 'next_turn', content: 'Keep the screenshot small.', attachments: [] })))
        .toMatchObject({ state: 'queued' })
      provider.release(orchestrator)
      await expect.poll(async () => (await f.runs.get(f.f.run.id))?.executionState, { timeout: 15_000 }).toBe('completed')
      const late = EngineChatReadbackSchema.parse(await workflowChatCall(f, 'agent_chat_read', { target: workerTarget }))
      expect(late.receipts.find(item => item.commandId === 'late-note')).toMatchObject({ state: 'failed', errorCode: 'TARGET_SETTLED' })
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
      expect(await drive).not.toBeInstanceOf(Error)
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)
})
