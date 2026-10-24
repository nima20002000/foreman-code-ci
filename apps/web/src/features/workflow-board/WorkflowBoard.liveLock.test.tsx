import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type Agent } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { editorAgents, nextDraftKey } from '../board-core'
import { useGraphDraftStore } from '../graph'
import { boardStartClient } from './startClient'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'

installBoardTestLifecycle()
let serial = 0
const authoring = () => screen.getByLabelText('Workflow authoring')
const canvas = () => within(screen.getByLabelText('Editable workflow graph'))
const controls = () => within(screen.getByLabelText('Workflow controls'))

async function fixture(asking = false) {
  const source = currentWorkflowFixture(`live-lock-${++serial}`)
  const mock = createCurrentBoardMock({ workspaceId: source.scope.workspaceId, allowSimulatedStart: true,
    agents: source.configurations.map((configuration, index): Agent => ({
      id: configuration.agentId, name: source.version.definition.nodes[index]!.name!, productRole: 'coder',
      configurationVersionId: configuration.id, harness: 'codex',
      harnessConfiguration: { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low',
        sandbox: 'read-only', serviceTier: 'standard', ...(asking ? {
        advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request' as const },
      } : {}) }, prompt: {}, assignedSkills: [],
    })) })
  mock.install(source.version.definition, true)
  server.use(
    http.get('*/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })),
    http.get(`*/api/management/workspaces/${mock.workspaceId}/workflows/${source.scope.workflowId}/runs/summaries`, () =>
      HttpResponse.json({ items: [...mock.runs.values()].reverse().map(({ run }) => ({ runId: run.id,
        shortId: run.id, startedAt: run.createdAt, status: run.executionState === 'completed' ? run.outcome : run.executionState,
        trigger: 'manual' })), pageInfo: { nextCursor: null } })), ...mock.handlers)
  const mounted = await mountMeasuredBoard(`/workspaces/${mock.workspaceId}?workflowId=${source.scope.workflowId}`)
  const key = nextDraftKey(mock.workspaceId, source.scope.workflowId)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  await waitFor(() => expect(canvas().getByRole('button', { name: /^Synthetic Worker 2,/ })).toBeVisible())
  const draft = () => useGraphDraftStore.getState().nextDrafts[key]!
  const externalRun = async () => {
    const managed = mock.managed(source.scope.workflowId), version = mock.versions.get(managed.currentVersionId!)!
    const result = await boardStartClient.start({ workspaceId: mock.workspaceId, workflowId: source.scope.workflowId,
      executionSemanticsVersion: 3, commandId: `external-${serial}`, workflowVersionId: version.id,
      expectedWorkflowRevision: managed.revision, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      expectedLocationRevision: 1, input: {} })
    await mounted.cache.invalidateQueries()
    await waitFor(() => expect(within(authoring()).getByTitle('Rename workflow')).toBeDisabled())
    return result.run
  }
  const finish = async (runId: string) => {
    mock.settle(runId)
    await mounted.cache.invalidateQueries()
    await waitFor(() => expect(within(authoring()).getByTitle('Rename workflow')).toBeEnabled())
  }
  return { ...mounted, mock, key, draft, externalRun, finish }
}

async function boardKeys(user: ReturnType<typeof userEvent.setup>, keys: string) {
  act(() => { (document.activeElement as HTMLElement | null)?.blur() })
  await user.keyboard(keys)
}

describe('live Board edit lock', () => {
  it('says the Board is locked while its Run is live, and editing again once it finishes', async () => {
    const f = await fixture()
    const views = () => screen.getByRole('navigation', { name: 'Workflow views' })
    expect(within(views()).getByText('Editing draft')).toBeVisible()
    const run = await f.externalRun()
    expect(within(views()).getByText('Run in progress · editing locked')).toBeVisible()
    await f.finish(run.id)
    expect(within(views()).getByText('Editing draft')).toBeVisible()
  }, 30_000)

  it.each(['Delete', 'Backspace'])('blocks %s on a selected node until the Run finishes', async key => {
    const f = await fixture(), user = userEvent.setup()
    fireEvent.click(canvas().getByRole('button', { name: /^Synthetic Worker 2,/ }))
    await waitFor(() => expect(canvas().getByRole('button', { name: /^Synthetic Worker 2,/ })).toHaveAttribute('aria-pressed', 'true'))
    const before = structuredClone(f.draft().graph)
    const run = await f.externalRun()
    await boardKeys(user, `{${key}}`)
    expect(canvas().getByRole('button', { name: /^Synthetic Worker 2,/ })).toBeVisible()
    expect(f.draft().graph).toEqual(before)
    await f.finish(run.id)
    await boardKeys(user, `{${key}}`)
    await waitFor(() => expect(canvas().queryByRole('button', { name: /^Synthetic Worker 2,/ })).not.toBeInTheDocument())
    expect(f.draft().graph.nodes).toHaveLength(1)
  }, 30_000)

  it.each(['Control', 'Meta'])('blocks %s+V with a populated clipboard until the Run finishes', async modifier => {
    const f = await fixture(), user = userEvent.setup()
    fireEvent.click(canvas().getByRole('button', { name: /^Synthetic Worker 2,/ }))
    await waitFor(() => expect(canvas().getByRole('button', { name: /^Synthetic Worker 2,/ })).toHaveAttribute('aria-pressed', 'true'))
    await boardKeys(user, `{${modifier}>}c{/${modifier}}`)
    const before = structuredClone(f.draft().graph)
    const run = await f.externalRun()
    await boardKeys(user, `{${modifier}>}v{/${modifier}}`)
    expect(canvas().queryByRole('button', { name: /^Synthetic Worker 2 copy,/ })).not.toBeInTheDocument()
    expect(f.draft().graph).toEqual(before)
    await f.finish(run.id)
    await boardKeys(user, `{${modifier}>}v{/${modifier}}`)
    expect(await canvas().findByRole('button', { name: /^Synthetic Worker 2 copy,/ })).toBeVisible()
    expect(f.draft().graph.nodes).toHaveLength(3)
  }, 30_000)

  it('keeps alerts readable but blocks their Agent repair until the Run finishes', async () => {
    const f = await fixture(true), user = userEvent.setup()
    // The saved version uses user approvals. An unsaved draft selects native handling;
    // an external Run still starts the exact saved version while that draft stays open.
    act(() => useGraphDraftStore.getState().changeNextDraft(f.key, graph => ({ ...graph, approval: { handler: 'native' } })))
    await user.click(within(authoring()).getByRole('button', { name: /^Workflow alerts,/ }))
    const alerts = await screen.findByRole('dialog', { name: 'Workflow alerts' })
    const repair = within(alerts).getByRole('button', { name: 'Set these agents to never ask' })
    expect(repair).toBeEnabled()
    const before = structuredClone(editorAgents(f.draft()))
    const run = await f.externalRun()
    expect(alerts).toBeVisible()
    expect(alerts).toHaveTextContent('ask you for approval')
    expect.soft(repair).toBeDisabled()
    fireEvent.click(repair)
    expect(editorAgents(f.draft())).toEqual(before)
    await f.finish(run.id)
    expect(repair).toBeEnabled()
    await user.click(repair)
    await waitFor(() => expect(within(alerts).queryByRole('button', { name: 'Set these agents to never ask' })).not.toBeInTheDocument())
    expect(alerts).not.toHaveTextContent('ask you for approval')
    expect(alerts).toHaveTextContent('Add an Orchestrator')
    expect(editorAgents(f.draft()).every(agent => agent.harnessConfiguration?.harness === 'codex'
      && agent.harnessConfiguration.advanced?.approvalPolicy === 'never')).toBe(true)
  }, 30_000)

  it.each(['Master', 'Orchestrator', 'Worker'])('blocks %s in an already-open Add agent menu until the Run finishes', async role => {
    const f = await fixture(), user = userEvent.setup()
    await user.click(controls().getByRole('button', { name: 'Add agent' }))
    const menu = await screen.findByRole('menu', { name: 'Add agent' })
    const item = within(menu).getByRole('menuitem', { name: role })
    const nodeName = role === 'Worker' ? 'Worker 3' : role
    await waitFor(() => expect(item).not.toHaveAttribute('aria-disabled', 'true'))
    const before = structuredClone(f.draft().graph)
    const run = await f.externalRun()
    expect(controls().getByRole('button', { name: 'Add agent' })).toBeDisabled()
    expect.soft(item).toHaveAttribute('aria-disabled', 'true')
    await user.click(item)
    expect(f.draft().graph).toEqual(before)
    expect(canvas().queryByRole('button', { name: new RegExp(`^${nodeName},`) })).not.toBeInTheDocument()
    await f.finish(run.id)
    expect(item).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(item)
    expect(await canvas().findByRole('button', { name: new RegExp(`^${nodeName},`) })).toBeVisible()
    expect(f.draft().graph.nodes).toHaveLength(3)
  }, 30_000)
})
