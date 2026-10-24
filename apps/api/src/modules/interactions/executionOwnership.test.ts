import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { WorkflowChatLockedTarget, WorkflowChatTarget } from '../collaboration/workflowControlTypes.js'
import type { RunOwnership } from '../runs/ownership.js'
import { ApprovalExecutionCoordinator, type ApprovalExecutionDependencies } from './execution.js'

function fixture() {
  const events: string[] = []
  const execution: HarnessExecution = {
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1, input: {}, state: 'running',
    workingDirectory: '/project', runtimeDirectory: '/runtime', createdAt: '2026-10-23T00:00:00.000Z',
  }
  const target: WorkflowChatTarget = { kind: 'workflow_execution',
    agent: { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' },
    execution: { runId: 'run', workflowVersionId: 'version', executionId: execution.id, attempt: 1 } }
  function owner(name: string) {
    return { runId: 'run', assertOwned() {}, retain() {
      events.push(`retain:${name}`)
      return async () => { events.push(`release:${name}`) }
    }, release: async () => { events.push(`release:${name}`) } } as unknown as RunOwnership
  }
  const acquired = owner('acquired')
  const dependencies = {
    runs: {
      getExecution: async () => { events.push('read-execution'); return execution },
      acquireOwnership: async () => { events.push('acquire'); return acquired },
      repeat: async () => ({ workflowChatTransaction: async <T>(selected: WorkflowChatTarget,
        _native: unknown, check: () => void, work: (context: WorkflowChatLockedTarget) => Promise<T>) => {
        events.push('transaction')
        check()
        return work({ target: selected } as WorkflowChatLockedTarget)
      } }),
    },
    interactions: { coordination: {} }, budgets: {}, activeTimeoutMs: 1_000,
    managers: { resolve() { throw new Error('A chat transaction must not allocate a native manager.') } },
  } as unknown as ApprovalExecutionDependencies
  const coordinator = new ApprovalExecutionCoordinator(dependencies)
  const chat = coordinator.workflowChatOwner({} as SqlQuery, async () => {
    throw new Error('These transactions do not submit chat input.')
  })
  return { events, target, coordinator, chat, owner }
}

it('retains the shared Run owner before a chat transaction and releases it after the callback', async () => {
  const f = fixture()
  const unshare = f.coordinator.shareRunOwner(f.owner('shared'))
  const result = await f.chat.transaction(f.target, async context => {
    assert.deepEqual(context.target, f.target)
    f.events.push('callback')
    return 'saved'
  })
  assert.equal(result, 'saved')
  assert.deepEqual(f.events, ['read-execution', 'retain:shared', 'transaction', 'callback', 'release:shared'])
  unshare()
})

it('releases the retained Run owner when the chat transaction callback rejects', async () => {
  const f = fixture()
  const unshare = f.coordinator.shareRunOwner(f.owner('shared'))
  const error = new Error('write failed')
  await assert.rejects(f.chat.transaction(f.target, async () => { throw error }), candidate => candidate === error)
  assert.deepEqual(f.events, ['read-execution', 'retain:shared', 'transaction', 'release:shared'])
  unshare()
})

it('keeps the successor shared owner when an earlier sharing ends, then acquires after unsharing', async () => {
  const f = fixture()
  const unsharePrevious = f.coordinator.shareRunOwner(f.owner('previous'))
  const unshareCurrent = f.coordinator.shareRunOwner(f.owner('current'))
  unsharePrevious()
  await f.chat.transaction(f.target, async () => 'first')
  unshareCurrent()
  await f.chat.transaction(f.target, async () => 'second')
  assert.deepEqual(f.events, ['read-execution', 'retain:current', 'transaction', 'release:current',
    'read-execution', 'acquire', 'transaction', 'release:acquired'])
})
