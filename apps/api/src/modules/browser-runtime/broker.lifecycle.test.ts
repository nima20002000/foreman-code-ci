import { expect, it, vi } from 'vitest'
import { BrowserControlSchema } from '@foreman-code/contracts/browser-sessions'
import { DomainError } from '../errors.js'
import { BrowserBroker } from './broker.js'
import type { AgentSubject, BrowserActor, BrowserNativeDriver, BrowserPreparedBinding,
  BrowserPrepareResult, BrowserRuntimeJournal, BrowserRuntimeReceipt, BrowserRuntimeSessionRecord,
  BrowserSession, BrowserSubjectAuthority, NativeBrowserTab, NodeBrowserSettings } from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function execution(node = 'node', attempt = 1): AgentSubject {
  return { kind: 'execution', agent: { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: node,
    agentId: 'reusable-agent', productRole: 'coder', displayName: 'Builder', configurationVersionId: 'configuration' },
  execution: { runId: 'run', workflowVersionId: 'workflow-version', executionId: `${node}-execution`, attempt } }
}

function memoryJournal(): BrowserRuntimeJournal {
  const commands = new Map<string, BrowserRuntimeReceipt>(), sessions = new Map<string, BrowserRuntimeSessionRecord>()
  return {
    read: async key => { const value = commands.get(key); return value ? structuredClone(value) : undefined },
    write: async (key, receipt) => { commands.set(key, structuredClone(receipt)) },
    saveSession: async value => { sessions.set(value.session.id, structuredClone(value)) },
    loadSessions: async () => [...sessions.values()].map(value => structuredClone(value)),
  }
}

function nativeFixture() {
  let nextTarget = 0
  const profiles = new Map<string, number>()
  const tabs = new Map<string, NativeBrowserTab & { profileId: string; generation: number }>()
  const driver: BrowserNativeDriver = {
    openProfile: vi.fn(async profileId => {
      const generation = profiles.get(profileId) ?? 1; profiles.set(profileId, generation); return { generation }
    }),
    reconnectProfile: vi.fn(async profileId => profiles.has(profileId) ? { generation: profiles.get(profileId)! } : null),
    restoreTab: vi.fn(async (profileId, generation, targetId) => {
      const tab = tabs.get(targetId)
      return tab?.profileId === profileId && tab.generation === generation ? tab : null
    }),
    createTab: vi.fn(async (profileId, generation) => {
      const tab = { targetId: `native-target-${++nextTarget}`, title: 'Fixture page', url: 'about:blank', profileId, generation }
      tabs.set(tab.targetId, tab); return tab
    }),
    closeTab: vi.fn(async (profileId, generation, targetId) => {
      const tab = tabs.get(targetId)
      if (tab && (tab.profileId !== profileId || tab.generation !== generation)) throw new Error('Foreign native target')
      tabs.delete(targetId)
    }),
    dispatch: vi.fn(async (profileId, generation, targetId, method, params) => {
      const tab = tabs.get(targetId)
      if (!tab || tab.profileId !== profileId || tab.generation !== generation) throw new Error('Foreign native dispatch')
      return { method, params }
    }),
    action: vi.fn(async (action, dispatch) => dispatch('Fixture.action', { action })),
    observe: vi.fn(async dispatch => {
      await dispatch('Fixture.observe')
      return { title: 'Observed fixture', url: 'https://fixture.test/', text: 'Fixture content', dialog: null }
    }),
    input: vi.fn(async (input, dispatch) => { await dispatch('Fixture.input', { input }) }),
    releasePressed: vi.fn(async dispatch => { await dispatch('Fixture.releasePressed') }),
    capture: vi.fn(async () => async () => undefined), openLocal: vi.fn(async () => undefined),
    facts: vi.fn(() => ({ dialog: null, uploadChooser: null })),
    onTabClosed: vi.fn(() => () => undefined), onPopup: vi.fn(() => () => undefined),
  }
  return { driver }
}

function fixture() {
  const { driver } = nativeFixture(), journal = memoryJournal()
  const assignments = new Map<string, BrowserPreparedBinding>(), ended = new Set<string>()
  const subjectKey = (subject: AgentSubject) => JSON.stringify(subject)
  const authority: BrowserSubjectAuthority = {
    resolve: vi.fn(async subject => {
      const binding = assignments.get(subjectKey(subject))
      if (!binding) throw new DomainError('BROWSER_SCOPE_MISMATCH', 'Unknown exact subject.', 403)
      return structuredClone(binding)
    }),
    assertCurrent: vi.fn(async subject => {
      if (ended.has(subjectKey(subject))) throw new DomainError('AGENT_SUBJECT_ENDED', 'The exact subject has ended.', 403)
    }),
  }
  const broker = new BrowserBroker({ computerId: 'main', driver, journal, authority })
  const request = (subject: AgentSubject = execution(), commandId = 'prepare', profileId = 'profile') => {
    const browser: NodeBrowserSettings = { enabled: true, profileId }
    assignments.set(subjectKey(subject), { subject, browser, computerId: 'main', readOnly: false, availability: 'ready' })
    return { subject, browser, computerId: 'main', commandId }
  }
  return { driver, journal, authority, broker, request,
    end: (subject: AgentSubject) => { ended.add(subjectKey(subject)) },
    assignment: (subject: AgentSubject, browser: NodeBrowserSettings) => {
      assignments.set(subjectKey(subject), { subject, browser, computerId: 'main', readOnly: false, availability: 'ready' })
    } }
}

function ready(result: BrowserPrepareResult) {
  if (result.kind !== 'ready') throw new Error(`Expected an owned browser, received ${result.reason}`)
  return result
}

it('retains a valid explained control state after setup closure and journal recovery', async () => {
  const f = fixture()
  const session = await f.broker.openSetup('profile', 'setup')
  expect(await f.broker.closeSetup(session.id)).toMatchObject({ state: 'closed' })
  const control = BrowserControlSchema.parse(f.broker.read(session.id).control)
  expect(control).toMatchObject({ state: 'paused', controllingViewerId: null, reason: expect.any(String) })
  const recovered = new BrowserBroker({ computerId: 'main', driver: f.driver, journal: f.journal, authority: f.authority })
  await recovered.recover()
  expect(recovered.read(session.id)).toMatchObject({ session: { state: 'closed' }, control })
  expect(await recovered.closeSetup(session.id)).toMatchObject({ state: 'already_closed' })
})

function agent(session: BrowserSession, epoch = 0): BrowserActor {
  return { kind: 'agent', epoch, browserGeneration: session.browserGeneration }
}

it('isolates exact node, attempt, conversation, setup and profile leases even when native profiles are shared', async () => {
  const f = fixture(), a = execution(), anotherNode = execution('other-node'), nextAttempt = execution('node', 2)
  const conversation: AgentSubject = { kind: 'conversation', agent: a.agent, conversationId: 'conversation' }
  const subjects = [a, anotherNode, nextAttempt, conversation]
  const sessions: BrowserSession[] = []
  for (const [index, subject] of subjects.entries()) sessions.push(ready(await f.broker.prepare(f.request(subject, `prepare-${index}`))).session)
  const otherProfile = ready(await f.broker.prepare(f.request(execution('separate-profile'), 'prepare-other', 'other-profile'))).session
  const setup = await f.broker.openSetup('profile', 'setup')
  const all = [...sessions, otherProfile, setup]
  expect(new Set(all.map(value => value.id)).size).toBe(all.length)
  expect(new Set(all.map(value => value.selectedTabId)).size).toBe(all.length)
  for (const [index, subject] of subjects.entries()) expect(f.broker.list(subject).map(value => value.id)).toEqual([sessions[index]!.id])
  const first = sessions[0]!, second = sessions[1]!, dispatched = vi.mocked(f.driver.dispatch).mock.calls.length
  await expect(f.broker.action({ sessionId: first.id, tabId: second.selectedTabId!, actor: agent(first),
    commandId: 'borrowed-tab', action: { kind: 'click', x: 10, y: 20 } })).rejects.toMatchObject({ code: 'BROWSER_TAB_SCOPE' })
  await expect(f.broker.release({ sessionId: first.id, subject: anotherNode, commandId: 'foreign-release', reason: 'terminal' }))
    .rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
  expect(vi.mocked(f.driver.dispatch).mock.calls.length).toBe(dispatched)
  expect(await f.broker.release({ sessionId: first.id, subject: a, commandId: 'release', reason: 'terminal' })).toMatchObject({ state: 'closed' })
  expect(f.broker.read(second.id).session.state).toBe('ready')
  expect(f.broker.read(setup.id).session.state).toBe('ready')
  expect(await f.broker.action({ sessionId: second.id, tabId: second.selectedTabId!, actor: agent(second),
    commandId: 'other-still-usable', action: { kind: 'click', x: 5, y: 6 } })).toMatchObject({ state: 'completed' })
})

it('replays the exact action receipt and rejects reusing its command ID with changed action or actor input', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const input = { sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session), commandId: 'navigate',
    action: { kind: 'navigate' as const, url: 'https://fixture.test/one' } }
  const receipt = await f.broker.action(input)
  expect(await f.broker.action(input)).toEqual(receipt)
  await expect(f.broker.action({ ...input, action: { ...input.action, url: 'https://fixture.test/two' } }))
    .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  await expect(f.broker.action({ ...input, actor: { ...input.actor, epoch: 1 } }))
    .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  expect(f.driver.action).toHaveBeenCalledTimes(1)
})

it('binds a preparation command to its original saved assignment and does not reopen a closed preparation on retry', async () => {
  const f = fixture(), input = f.request(), { session } = ready(await f.broker.prepare(input))
  expect(ready(await f.broker.prepare(input)).session.id).toBe(session.id)
  const updatedBrowser: NodeBrowserSettings = { enabled: true, profileId: 'new-profile' }
  f.assignment(input.subject, updatedBrowser)
  await expect(f.broker.prepare({ ...input, browser: updatedBrowser })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  f.assignment(input.subject, input.browser)
  await f.broker.release({ sessionId: session.id, subject: input.subject, commandId: 'terminal', reason: 'terminal' })
  expect(await f.broker.prepare(input)).toMatchObject({ kind: 'unavailable', retryable: false })
  const recovered = new BrowserBroker({ computerId: 'main', driver: f.driver, journal: f.journal, authority: f.authority })
  await recovered.recover()
  expect(await recovered.prepare(input)).toMatchObject({ kind: 'unavailable', retryable: false })
  expect(f.driver.createTab).toHaveBeenCalledTimes(1)
  expect(f.driver.openProfile).toHaveBeenCalledTimes(1)
})

it('acknowledges takeover only after releasing pressed state and fences a delayed helper follow-up', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const entered = deferred<void>(), proceed = deferred<void>()
  vi.mocked(f.driver.action).mockImplementationOnce(async (_action, dispatch) => {
    await dispatch('Fixture.first')
    entered.resolve(); await proceed.promise
    return dispatch('Fixture.late-follow-up')
  })
  const action = f.broker.action({ sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session),
    commandId: 'helper', action: { kind: 'click', x: 2, y: 3 } })
  const rejection = expect(action).rejects.toMatchObject({ code: 'BROWSER_PAUSED' })
  await entered.promise
  const control = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'viewer', commandId: 'take' })
  expect(control).toMatchObject({ state: 'user', controllingViewerId: 'viewer' })
  expect(f.driver.releasePressed).toHaveBeenCalledTimes(1)
  proceed.resolve(); await rejection
  expect(vi.mocked(f.driver.dispatch).mock.calls.map(call => call[3])).toEqual(['Fixture.first', 'Fixture.releasePressed'])
})

it('ignores a stale release without fencing the current agent or changing its control epoch', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration, viewerId: 'viewer', commandId: 'take' })
  const returned = await f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: held.epoch, commandId: 'return' })
  expect(returned.state).toBe('agent')
  await expect(f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: held.epoch, commandId: 'stale-return' }))
    .rejects.toMatchObject({ code: 'BROWSER_STALE_INPUT' })
  expect(f.broker.read(session.id).control).toEqual(returned)
  expect(await f.broker.action({ sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session, returned.epoch),
    commandId: 'current-agent', action: { kind: 'type', text: 'still admitted' } })).toMatchObject({ state: 'completed' })
})

it('retains an unknown action receipt after control and tab changes without dispatching that action twice', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  vi.mocked(f.driver.action).mockImplementationOnce(async (_action, dispatch) => {
    await dispatch('Fixture.native-effect')
    throw new Error('reply lost after native effect')
  })
  const input = { sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session), commandId: 'unknown',
    action: { kind: 'type' as const, text: 'one effect' } }
  await expect(f.broker.action(input)).rejects.toThrow('reply lost after native effect')
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration, viewerId: 'viewer', commandId: 'take' })
  const returned = await f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: held.epoch, commandId: 'return' })
  const current = agent(session, returned.epoch)
  const created = await f.broker.createTab({ sessionId: session.id, actor: current, commandId: 'new-tab' })
  await f.broker.closeTab({ sessionId: session.id, tabId: input.tabId, actor: current, commandId: 'close-old-tab' })
  await expect(f.broker.action(input)).rejects.toMatchObject({ code: 'BROWSER_RESULT_UNKNOWN' })
  await expect(f.broker.action({ ...input, actor: current, tabId: created.createdTabId })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  expect(f.driver.action).toHaveBeenCalledTimes(1)
  expect(vi.mocked(f.driver.dispatch).mock.calls.filter(call => call[3] === 'Fixture.native-effect')).toHaveLength(1)
})

it('returns a completed action receipt after its old tab closes without applying the action again', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const input = { sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session), commandId: 'completed',
    action: { kind: 'click' as const, x: 20, y: 30 } }
  const receipt = await f.broker.action(input)
  await f.broker.createTab({ sessionId: session.id, actor: input.actor, commandId: 'new-tab' })
  await f.broker.closeTab({ sessionId: session.id, tabId: input.tabId, actor: input.actor, commandId: 'close-old-tab' })
  expect(await f.broker.action(input)).toEqual(receipt)
  expect(f.driver.action).toHaveBeenCalledTimes(1)
})

it('rechecks terminal subject authority after a delayed profile allocation before creating its first tab', async () => {
  const f = fixture(), input = f.request(), entered = deferred<void>(), proceed = deferred<void>()
  const open = vi.mocked(f.driver.openProfile).getMockImplementation()!
  vi.mocked(f.driver.openProfile).mockImplementationOnce(async profileId => {
    const profile = await open(profileId); entered.resolve(); await proceed.promise; return profile
  })
  const opening = f.broker.prepare(input), rejection = expect(opening).rejects.toMatchObject({ code: 'AGENT_SUBJECT_ENDED' })
  await entered.promise; f.end(input.subject); proceed.resolve(); await rejection
  expect(f.driver.createTab).not.toHaveBeenCalled()
  expect(f.broker.list(input.subject)).toEqual([])
  expect(f.broker.activeSessionCount()).toBe(0)
})

it('compensates an already allocated tab when its exact subject ends before preparation can complete', async () => {
  const f = fixture(), input = f.request(), entered = deferred<void>(), proceed = deferred<void>()
  const create = vi.mocked(f.driver.createTab).getMockImplementation()!
  vi.mocked(f.driver.createTab).mockImplementationOnce(async (profileId, generation, token) => {
    const tab = await create(profileId, generation, token); entered.resolve(); await proceed.promise; return tab
  })
  const opening = f.broker.prepare(input), rejection = expect(opening).rejects.toMatchObject({ code: 'AGENT_SUBJECT_ENDED' })
  await entered.promise; f.end(input.subject); proceed.resolve(); await rejection
  expect(f.driver.closeTab).toHaveBeenCalledTimes(1)
  expect(f.broker.list(input.subject)).toEqual([expect.objectContaining({ state: 'closed', selectedTabId: null })])
  expect(f.broker.activeSessionCount()).toBe(0)
})

it('healthy reconnect preserves another controlling viewer and never steals or invalidates its current epoch', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'first-viewer', commandId: 'take-first' })
  const read = await f.broker.reconnect({ sessionId: session.id, commandId: 'other-viewer-reconnect' })
  expect(read.control).toEqual(held)
  expect(f.driver.reconnectProfile).not.toHaveBeenCalled()
  const denied = { sessionId: session.id, browserGeneration: session.browserGeneration, viewerId: 'second-viewer', commandId: 'busy-take' }
  await expect(f.broker.acquire(denied)).rejects.toMatchObject({ code: 'BROWSER_CONTROL_BUSY' })
  expect(f.broker.read(session.id).control).toEqual(held)
  await f.broker.releaseControl({ sessionId: session.id, viewerId: 'first-viewer', epoch: held.epoch, commandId: 'return' })
  await expect(f.broker.acquire(denied)).rejects.toMatchObject({ code: 'BROWSER_CONTROL_BUSY' })
  expect(await f.broker.acquire({ ...denied, commandId: 'fresh-take' })).toMatchObject({ state: 'user', controllingViewerId: 'second-viewer' })
})
