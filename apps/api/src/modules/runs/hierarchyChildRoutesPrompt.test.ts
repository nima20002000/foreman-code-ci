import { describe, expect, it } from 'vitest'
import type { WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'
import { workflowCoordinationPrompt } from './workflowCoordinationPrompt.js'
import { hierarchyWorkPrompt } from './hierarchyWorkPrompt.js'

const definition = {
  nodes: [
    { id: 'master', name: 'Master', agentId: 'a1', choice: { outcomes: [{ outcome: 'delegate_node_o', target: { kind: 'edge', relationshipId: 'e1' } }] } },
    { id: 'orchestrator', name: 'Orchestrator', agentId: 'a2', choice: { outcomes: [{ outcome: 'delegate_node_w', target: { kind: 'edge', relationshipId: 'e2' } }] } },
    { id: 'worker', name: 'Worker', agentId: 'a3' },
  ],
  edges: [{ id: 'e1', kind: 'execution', source: 'master', target: 'orchestrator' },
    { id: 'e2', kind: 'execution', source: 'orchestrator', target: 'worker' }],
  hierarchy: { version: 1, masterNodeId: 'master', parents: [{ workflowNodeId: 'orchestrator', parentNodeId: 'master' },
    { workflowNodeId: 'worker', parentNodeId: 'orchestrator' }] },
  handoffs: { contractVersion: 1 },
} as unknown as WorkflowDefinitionCurrent

describe('hierarchy delegation prompt', () => {
  it('names the direct child each saved delegate route reaches', () => {
    const master = workflowCoordinationPrompt({ resultProtocol: 'f1-f4-v1', definition, workflowNodeId: 'master', interval: false } as never)
    expect(master).toContain('"delegate_node_o" → Orchestrator')
    expect(master).not.toContain('→ Worker')
    expect(hierarchyWorkPrompt(definition, 'orchestrator')).toContain('"delegate_node_w" → Worker')
    expect(hierarchyWorkPrompt(definition, 'worker')).toContain('You have no direct children to delegate to.')
  })
})
