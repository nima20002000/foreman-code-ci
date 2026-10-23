import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, HarnessExecutionSchema, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'
import { readWorkflowTeam } from './workflowTeamPrompt.js'

/** The owner's saved two-agent shape: Orchestrator -> Worker, no named routes, Worker has a browser. */
function ownerWorkflow() {
  const f = makeCurrentWorkflowFixture('orchestrator-team', 'sequential')
  const [orchestrator, worker] = f.version.definition.nodes
  f.version.definition.handoffs = { contractVersion: 1 }
  orchestrator!.name = 'Orchestrator'
  orchestrator!.initialPrompt = 'You are the orchestrator agent. Your job is to qualify the other agent\'s job.'
  worker!.name = 'Worker'
  worker!.initialPrompt = 'Obey the orchestrator agent.'
  worker!.browser = { enabled: true, profileId: '7b53af53-4b49-42db-a857-5e621a2df038' }
  const configurations: AgentConfigurationVersion[] = f.configurations.map((configuration, index) => index === 0
    ? { ...configuration, productRole: 'orchestrator', prompt: { system: 'Tell the other agent to take a screenshot of google.com.' } }
    : configuration)
  const read = async (id: string) => configurations.find(configuration => configuration.id === id)
  const execution = (nodeId: string, work: unknown) => HarnessExecutionSchema.parse({ id: `execution-${nodeId}`, runId: f.run.id,
    workflowNodeId: nodeId, agentId: f.version.definition.nodes.find(node => node.id === nodeId)!.agentId,
    agentConfigurationVersionId: configurations.find(configuration =>
      configuration.agentId === f.version.definition.nodes.find(node => node.id === nodeId)!.agentId)!.id,
    attempt: 1, state: 'starting', createdAt: f.createdAt, workingDirectory: '/work', runtimeDirectory: '/runtime',
    input: WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null,
      predecessors: [], work }) })
  return { f, orchestrator: orchestrator!, worker: worker!, configurations, read, execution }
}

describe('connected agents in the workflow prompt', () => {
  it('tells the Orchestrator who its Worker is, what it can do, and how to give it work and check the result', async () => {
    const { f, orchestrator, configurations, read, execution } = ownerWorkflow()
    const prompt = buildHarnessPrompt(workflowExecutionRequest({
      execution: execution(orchestrator.id, { kind: 'entry', activation: { scope: f.scope, activationId: 'entry',
        workflowNodeId: orchestrator.id, lineageId: f.run.id, cause: { kind: 'entry' } } }),
      version: f.version, configuration: configurations[0]!, workspaceId: f.scope.workspaceId,
      resultProtocol: COORDINATION_RESULT_PROTOCOL, team: await readWorkflowTeam(f.version, orchestrator.id, read) }))
    expect(prompt).toContain('- "Worker" (Worker; has a web browser). Their instructions: "Obey the orchestrator agent."')
    expect(prompt).toContain('To give "Worker" work, finish with {"kind":"finish"}, remainingFindings [] and their complete task in data.latestDeliverable')
    expect(prompt).toContain('Their result comes back to you as a work request.')
  })

  it('tells the Worker who gave it the work and that its finished result goes back to that Orchestrator', async () => {
    const { f, orchestrator, worker, configurations, read, execution } = ownerWorkflow()
    const request = { scope: f.scope, requestId: 'request-1', relationshipId: f.version.definition.edges[0]!.id,
      requesterActivationId: 'entry', requesterExecutionId: `execution-${orchestrator.id}`, destinationActivationId: 'worker',
      requesterNodeId: orchestrator.id, destinationNodeId: worker.id, payloadDigest: `sha256:${'1'.repeat(64)}`,
      acceptedAt: f.createdAt, ordinal: 1 }
    const prompt = buildHarnessPrompt(workflowExecutionRequest({
      execution: execution(worker.id, { kind: 'work_request', activation: { scope: f.scope, activationId: 'worker',
        workflowNodeId: worker.id, lineageId: f.run.id, cause: { kind: 'work_request', requestId: 'request-1' } }, request,
      acceptedSourceResult: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
        data: { latestDeliverable: { task: 'Screenshot google.com' }, remainingFindings: [] } } } }),
      version: f.version, configuration: configurations[1]!, workspaceId: f.scope.workspaceId,
      team: await readWorkflowTeam(f.version, worker.id, read) }))
    expect(prompt).toContain('- "Orchestrator" (Orchestrator). Their instructions: "You are the orchestrator agent.')
    expect(prompt).toContain('Tell the other agent to take a screenshot of google.com.')
    expect(prompt).toContain('"Orchestrator" gave you this work and checks your result. When done, finish with {"kind":"finish"} (not return)')
    expect(prompt).not.toContain('Use routing.kind "return" only to answer')
  })
})
