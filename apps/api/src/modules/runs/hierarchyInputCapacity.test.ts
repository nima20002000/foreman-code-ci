import { describe, expect, it } from 'vitest'
import { HierarchyWorkGroupSchema, WorkActivationIdentitySchema } from '@foreman-code/contracts/wave25'
import { hasHierarchyParentInputCapacity } from './hierarchyInputCapacity.js'

function fixture(count: number) {
  const id = (prefix: string) => prefix.padEnd(200, 'x')
  const scope = { workspaceId: id('workspace'), workflowId: id('workflow'), workflowVersionId: id('version'),
    runId: id('run'), executionSemanticsVersion: 3 }
  const members = Array.from({ length: count }, (_, index) => ({
    requestId: id(`request-${index}`), destinationNodeId: id(`child-${index}`),
  }))
  const group = HierarchyWorkGroupSchema.parse({ scope, groupId: id('group'), parentActivationId: id('parent'),
    parentExecutionId: id('parent-execution'), parentNodeId: id('master'), continuationActivationId: id('summary'),
    sourceResultDigest: `sha256:${'1'.repeat(64)}`, memberRequestIds: members.map(member => member.requestId),
    createdAt: '2026-10-20T00:00:00Z' })
  const activation = WorkActivationIdentitySchema.parse({ scope, activationId: group.continuationActivationId,
    workflowNodeId: group.parentNodeId, lineageId: scope.runId, cause: { kind: 'hierarchy_group', groupId: group.groupId } })
  return { group, activation, members }
}

describe('hierarchy parent input reservation', () => {
  it('admits the bounded contract maximum with worst-case feedback identities and original input', () => {
    const f = fixture(1000)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation, { request: 'x'.repeat(64 * 1024) }, f.members)).toBe(true)
  })
  it('refuses a valid near-limit original input before a small group can strand its parent', () => {
    const f = fixture(2)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation,
      { request: 'x'.repeat(4 * 1024 * 1024 - 2048) }, f.members)).toBe(false)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation, { request: 'x'.repeat(3 * 1024 * 1024) }, f.members)).toBe(true)
  })
})
