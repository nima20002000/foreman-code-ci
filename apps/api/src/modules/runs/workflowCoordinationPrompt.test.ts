import { describe, expect, it } from 'vitest'
import type { WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'
import { workflowCoordinationPrompt } from './workflowCoordinationPrompt.js'

const definition = {
  nodes: [{ id: 'orchestrator', name: 'Orchestrator', agentId: 'a1' }, { id: 'worker', name: 'Worker', agentId: 'a2' }],
  edges: [{ id: 'e1', kind: 'execution', source: 'orchestrator', target: 'worker' }],
  handoffs: { contractVersion: 1 },
} as unknown as WorkflowDefinitionCurrent

describe('connected-Agent result prompt', () => {
  it('says unresolved findings fail the Run and promises no owner direction that never comes', () => {
    const prompt = workflowCoordinationPrompt({ resultProtocol: 'f1-f4-v1', definition, workflowNodeId: 'orchestrator', interval: false } as never)
    expect(prompt).toContain('Non-empty remainingFindings with nobody to hand them to fail the Run with them as the reason.')
    expect(prompt).not.toContain('owner direction')
  })
})
