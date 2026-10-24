import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type AgentSubject, type BrowserPrepareResult } from '@foreman-code/contracts'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { createProductionBrowser } from '../src/modules/collaboration/browserComposition.js'
import { readWorkflowChatAgent } from '../src/modules/collaboration/workflowChatIdentity.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { fixture, startInput } from './helpers/nodePlacementStartFixture.js'

it('prepares an unpublished browser profile on the Worker pinned by HTTP Save and Start', async () => {
  const f = await fixture()
  const main = f.placement.local.hostRef, worker = f.placement.remote.hostRef
  if (main.kind !== 'main' || worker.kind !== 'device') throw new Error('Expected Main and a Worker')
  const unused = async (): Promise<never> => { throw new Error('Unexpected browser transport') }
  const prepare = vi.fn(async (input: Parameters<typeof browser.lifecycle.prepare>[0]): Promise<BrowserPrepareResult> => {
    expect(await browser.authority.resolve(input.subject, { readyComputerId: worker.deviceId })).toMatchObject({ availability: 'ready' })
    return { kind: 'ready', session: { id: 'placed-browser', subject: input.subject, profileId: 'profile',
      computerId: worker.deviceId, browserGeneration: 1, state: 'ready', selectedTabId: null },
    control: { sessionId: 'placed-browser', state: 'agent', epoch: 1, controllingViewerId: null, reason: null } }
  })
  const browser = createProductionBrowser({ pool: f.base.db.pool, stateDirectory: f.base.db.directory, binding: () => null,
    assertHostOwnership: async () => undefined, reportFailure: () => undefined,
    remote: () => ({ profiles: { endpoint: unused }, sessions: { invoke: unused }, prepare, release: unused,
      ready: async () => true, status: async computerId => ({ computerId, ready: true, phase: 'ready', reason: null }),
      media: () => { throw new Error('No viewer in this test') } }) })
  vi.spyOn(browser.profiles.host, 'status').mockResolvedValue('ready')
  const create = vi.spyOn(browser.profiles.host, 'create').mockResolvedValue()
  vi.spyOn(browser.profiles.host, 'prune').mockResolvedValue()
  const receive = vi.spyOn(browser.profiles.host, 'receive').mockResolvedValue()
  try {
    await browser.profiles.service.repository.transaction(['profile:profile'], tx => tx.putProfile({
      profile: { id: 'profile', name: 'Demo profile', distribution: 'shared', sourceComputerId: main.mainId,
        revision: 1, publishedRevision: 0 }, deleted: false,
    }))
    const node = agentWorkflowNode(f.saveInput.graph.nodes[0])
    node.placement = f.placement.remote
    node.browser = { enabled: true, profileId: 'profile' }
    f.saveInput.graph.nodes = [node]
    f.saveInput.graph.edges = []
    f.saveInput.expectedAgentConfigurationVersionIds = { [node.agentId]: f.saveInput.expectedAgentConfigurationVersionIds[node.agentId]! }
    const saved = await f.save('http')
    const accepted = await f.start('http', startInput(f, saved))
    const response = await f.app.inject({ method: 'GET', headers: f.headers,
      url: `${f.path}/runs/${accepted.run.id}/nodes/${node.id}/placement` })
    expect(response.statusCode, response.body).toBe(200)
    expect(RunPlacementGetResultSchema.parse(response.json())).toMatchObject({ readback: {
      evidence: 'accepted', placement: { hostRef: worker },
    } })
    const executions = async () => (await f.base.db.pool.query<{ record: unknown }>(
      'select record from harness_executions where run_id=$1', [accepted.run.id])).rows
    await vi.waitFor(async () => expect(await executions()).toHaveLength(1))
    const execution = HarnessExecutionSchema.parse((await executions())[0]!.record)
    const subject: AgentSubject = { kind: 'execution',
      agent: await readWorkflowChatAgent(f.base.db.pool, saved.version, node.id),
      execution: { runId: accepted.run.id, workflowVersionId: saved.currentVersionId, executionId: execution.id, attempt: execution.attempt } }
    await browser.start(main.mainId)
    expect(await browser.lifecycle.prepare({ subject, browser: node.browser, computerId: worker.deviceId, commandId: randomUUID() }))
      .toMatchObject({ kind: 'ready', session: { computerId: worker.deviceId, profileId: 'profile' } })
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ computerId: worker.deviceId, profileId: 'profile' }))
    expect(receive).not.toHaveBeenCalled()
  } finally {
    await browser.stop()
    await f.close()
    vi.restoreAllMocks()
  }
}, 120_000)
