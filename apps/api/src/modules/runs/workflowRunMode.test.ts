import { describe, expect, it } from 'vitest'
import type { WorkflowVersionCurrent } from '@foreman-code/contracts/current'
import { declaresRepeatBlocks, usesWorkHandoffGraph, workflowRunMode } from './workflowRunMode.js'

const version = (definition: Record<string, unknown>) => ({ definition }) as unknown as WorkflowVersionCurrent

describe('workflow run mode', () => {
  it('runs an ordinary workflow on the plain graph without repeat', () => {
    const ordinary = version({ nodes: [], edges: [] })
    expect(workflowRunMode(ordinary)).toBe('graph')
    expect(usesWorkHandoffGraph(ordinary)).toBe(false)
    expect(declaresRepeatBlocks(ordinary)).toBe(false)
  })

  it('separates handoff and hierarchy workflows, which share the work-handoff graph', () => {
    const handoff = version({ handoffs: { enabled: true } })
    const hierarchy = version({ handoffs: { enabled: true }, hierarchy: { enabled: true } })
    expect(workflowRunMode(handoff)).toBe('handoff')
    expect(workflowRunMode(hierarchy)).toBe('hierarchy')
    expect(usesWorkHandoffGraph(handoff)).toBe(true)
    expect(usesWorkHandoffGraph(hierarchy)).toBe(true)
  })

  it('reports repeat only for explicit repeat blocks', () => {
    expect(declaresRepeatBlocks(version({ repeat: { blocks: [] } }))).toBe(true)
    expect(declaresRepeatBlocks(version({}))).toBe(false)
  })
})
