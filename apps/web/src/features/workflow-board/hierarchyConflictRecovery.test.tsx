// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { HttpResponse } from 'msw'
import { GraphEditAdvanceInputV3Schema, GraphEditStageInputV3Schema,
  type GraphEditIntentV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { readConflictRecoveries, readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { journalIntent, savedJournal } from '../graph/nextDraft/nim2644Journal.fixture'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'
import { meaningfulSaveFixture } from './meaningfulSave.testSupport'

installBoardTestLifecycle()
type Fixture = Awaited<ReturnType<typeof recoveryFixture>>
const draft = (f: Fixture) => useGraphDraftStore.getState().nextDrafts[f.key]!
const authoring = () => within(screen.getByRole('region', { name: 'Workflow authoring' }))

/** Only HTTP replies are simulated. The mounted router, editor, storage,
 * private-command journal client and fresh transport base are production code. */
async function recoveryFixture() {
  const f = await meaningfulSaveFixture()
  let saved = structuredClone(f.definition())
  const baseManaged = f.mock.managed(f.workflowId)
  const intents = new Map<string, GraphEditIntentV3>(), requests: GraphEditStageInputV3[] = []
  const controls = { failLatestRead: false, loseStageReply: false }
  const read = (draftId: string) => ({ intent: intents.get(draftId) ?? null, current: [], canStop: true, affectedSetChanged: false })
  const reply = async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && (url.pathname === f.path || url.pathname === `${f.path}/definition`)) {
      if (controls.failLatestRead) return HttpResponse.json({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Latest saved workflow could not be read.' } }, { status: 503 })
      return HttpResponse.json(url.pathname === f.path ? { ...baseManaged, workflow: saved.version.definition,
        revision: saved.revision, currentVersionId: saved.currentVersionId } : saved)
    }
    if (url.pathname !== `${f.path}/definition/edits`) return undefined
    if (request.method === 'GET') return HttpResponse.json(read(url.searchParams.get('draftId') ?? ''))
    const raw: unknown = await request.json()
    if ((raw as { action?: string }).action === 'stage_edits') {
      const input = GraphEditStageInputV3Schema.parse(raw); requests.push(structuredClone(input))
      const prior = intents.get(input.draftId)
      if (prior?.stageCommandId === input.commandId) return HttpResponse.json(read(input.draftId))
      if (input.expectedRevision !== saved.revision || input.expectedWorkflowVersionId !== saved.currentVersionId) {
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'The saved workflow changed. Inspect latest to compare your draft.' } }, { status: 409 })
      }
      const context = { draft: { ...f.mock.drafts.get(f.workflowId)!, graph: saved.version.definition,
        revision: saved.revision, publishedRevision: saved.revision, baseWorkflowVersionId: saved.currentVersionId }, agents: f.mock.catalog }
      intents.set(input.draftId, journalIntent(input, context))
      if (controls.loseStageReply) { controls.loseStageReply = false; return HttpResponse.error() }
      return HttpResponse.json(read(input.draftId))
    }
    const input = GraphEditAdvanceInputV3Schema.parse(raw), intent = intents.get(input.draftId)!
    expect(input.intentId).toBe(intent.id); expect(input.commandId).toBe(intent.advanceCommandId)
    if (intent.state !== 'saved') {
      const completed = savedJournal(intent, saved.version.version + 1)
      intents.set(input.draftId, completed)
      const result = completed.result!
      saved = { workspaceId: result.workspaceId, workflowId: result.workflowId, revision: result.revision,
        currentVersionId: result.currentVersionId, version: result.version }
    }
    return HttpResponse.json(read(input.draftId))
  }
  const externalEdit = (name: string) => {
    const version = saved.version.version + 1, id = `external-version-${version}`
    saved = { ...saved, revision: saved.revision + 1, currentVersionId: id,
      version: { ...saved.version, id, version, definition: { ...saved.version.definition, version, name } } }
  }
  const wire = measureBoardWire(f.mock, reply)
  return { ...f, controls, requests, externalEdit, wire, saved: () => saved }
}
async function mount(f: Fixture) {
  const view = await mountMeasuredBoard(f.href)
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await waitFor(() => expect(draft(f)).toBeDefined())
  await waitFor(() => expect(view.cache.getQueryState(graphEditIntentKey(f.workspaceId, f.workflowId,
    draft(f).context.draft.id))).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
  return view
}
async function rename(name: string) {
  await userEvent.click(authoring().getByTitle('Rename workflow'))
  const field = authoring().getByRole('textbox', { name: 'Workflow name' })
  await userEvent.clear(field); await userEvent.type(field, `${name}{Enter}`)
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Rename workflow?' })).getByRole('button', { name: 'Rename' }))
}
async function settings() {
  if (!screen.queryByRole('region', { name: 'Draft conflict recovery' })) await userEvent.click(authoring().getByRole('button', { name: 'Workflow settings' }))
  return screen.findByRole('region', { name: 'Draft conflict recovery' })
}

it('opens latest into a fresh durable base, retains repeated recoveries through refresh and saves only manually reapplied changes', async () => {
  const f = await recoveryFixture(), first = await mount(f)
  const originalId = draft(f).context.draft.id, originalVersion = draft(f).context.draft.baseWorkflowVersionId
  await rename('My first unsaved name')
  f.externalEdit('Other saved name')
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  const rejected = f.requests[0]!
  expect(readEditOutbox(f.key)).toBeUndefined()
  await settings()
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Other saved name'))
  const freshId = draft(f).context.draft.id
  expect(freshId).not.toBe(originalId)
  expect(draft(f).context.draft.baseWorkflowVersionId).toBe(f.saved().currentVersionId)
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'View unsaved draft' }))
  expect(screen.getByRole('region', { name: 'Read-only recovered draft' })).toHaveTextContent('My first unsaved name')
  expect(screen.getByRole('region', { name: 'Read-only recovered draft' })).toHaveTextContent(originalVersion!)
  await rename('My second unsaved name')
  f.externalEdit('Newer saved name')
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Newer saved name'))
  expect(readConflictRecoveries(f.key)).toHaveLength(2)
  const finalBase = { id: draft(f).context.draft.id, revision: draft(f).context.draft.publishedRevision,
    version: draft(f).context.draft.baseWorkflowVersionId }
  first.unmount()
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  await mount(f); await settings()
  expect(screen.getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2)
  expect(draft(f).context.draft.id).toBe(finalBase.id)
  await rename('My first unsaved name')
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
  const accepted = f.requests.at(-1)!
  expect(accepted.commandId).not.toBe(rejected.commandId)
  expect(accepted).toMatchObject({ draftId: finalBase.id, expectedRevision: finalBase.revision,
    expectedWorkflowVersionId: finalBase.version, graph: { name: 'My first unsaved name' } })
  expect(f.saved().version.definition.name).toBe('My first unsaved name')
  expect(readConflictRecoveries(f.key)).toHaveLength(2)
  await userEvent.click(screen.getAllByRole('button', { name: 'Discard recovered draft' })[0]!)
  await userEvent.click(within(await screen.findByRole('alertdialog', { name: 'Discard this recovered draft?' }))
    .getByRole('button', { name: 'Discard recovered draft' }))
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
  expect(f.wire.writes().every(sample => sample.path.endsWith('/definition/edits'))).toBe(true)
}, 30000)

it.each(['write', 'read', 'latest-response'] as const)('keeps the original editor and transport base when %s recovery fails', async failure => {
  const f = await recoveryFixture(); await mount(f)
  await rename('Keep this active form'); await settings()
  const original = draft(f), beforeReads = f.wire.samples.length
  f.externalEdit('Another saved base')
  const restore = failure === 'write' ? vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    : failure === 'read' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.includes('recovery')) throw new DOMException('Recovery read denied', 'SecurityError')
      return getItem.call(this, key)
    }) : undefined
  if (failure === 'latest-response') f.controls.failLatestRead = true
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  await screen.findAllByText(failure === 'latest-response' ? 'Latest saved workflow could not be read.'
    : failure === 'read' ? 'Recovery read denied' : /Durable edit storage is unavailable/)
  restore?.mockRestore(); f.controls.failLatestRead = false
  expect(draft(f).instanceId).toBe(original.instanceId)
  expect(draft(f).graph).toEqual(original.graph)
  expect(draft(f).context.draft).toEqual(original.context.draft)
  if (failure !== 'latest-response') expect(f.wire.samples.slice(beforeReads).filter(sample => sample.path === f.path)).toHaveLength(0)
  await rename('Keep this active form after retry')
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  expect(f.requests.at(-1)).toMatchObject({ draftId: original.context.draft.id,
    expectedRevision: original.context.draft.publishedRevision, expectedWorkflowVersionId: original.context.draft.baseWorkflowVersionId })
}, 30000)
const getItem = Storage.prototype.getItem

it('blocks Inspect latest while Stage is uncertain and reconciles the original immutable command before opening a fresh base', async () => {
  const f = await recoveryFixture(); await mount(f)
  await rename('Exact pending name'); await settings()
  f.controls.loseStageReply = true
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(readEditOutbox(f.key)).toBeDefined())
  const original = structuredClone(readEditOutbox(f.key)!.request)
  expect(screen.getByRole('button', { name: 'Inspect latest' })).toBeDisabled()
  expect(readConflictRecoveries(f.key)).toEqual([])
  await userEvent.click(authoring().getByRole('button', { name: 'Reconcile Save' }))
  await waitFor(() => expect(readEditOutbox(f.key)).toBeUndefined())
  expect(f.requests.length).toBeGreaterThan(1)
  for (const input of f.requests) expect(input).toEqual(original)
  expect(f.saved().version.definition.name).toBe('Exact pending name')
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(draft(f).context.draft.id).not.toBe(original.draftId))
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
}, 30000)
