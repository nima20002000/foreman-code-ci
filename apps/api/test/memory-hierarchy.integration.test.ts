import { expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowMemory } from './helpers/memoryWorkflow.js'

it('keeps linked master memory active until delegated hierarchy work returns', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const runtime = await currentOperatorIntegration({ fixture: hierarchyRuntimeFixture(), approvalNodeIds: [],
    collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const card = await workflowMemory(runtime)
  const drive = runtime.engine.start(runtime.f.run.id).catch(error => error)
  try {
    await Promise.race([provider.entered('builder'), drive.then(result => {
      throw result instanceof Error ? result : new Error('The Run ended before its delegated work started')
    })])
    expect(await card.read()).toMatchObject({ card: { status: 'doing' },
      bindings: [expect.objectContaining({ state: 'waiting_children' })] })
    provider.release('builder')
    expect(await drive).not.toBeInstanceOf(Error)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    expect(await card.read()).toMatchObject({ card: { status: 'done', completionKind: 'completed' },
      bindings: expect.arrayContaining([expect.objectContaining({ state: 'accepted' })]) })
  } finally {
    provider.releaseAll()
    await runtime.stop()
    await drive
    await runtime.close()
  }
}, 60_000)
