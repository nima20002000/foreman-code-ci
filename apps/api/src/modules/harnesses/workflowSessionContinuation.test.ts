import { expect, it } from 'vitest'
import { CodexAppServerSessionManager } from './codexAppServer.js'
import type { WorkflowNativeSessionStart } from './port.js'
import { ActivityProductionReplay } from '../../../test/helpers/activityProductionReplay.js'
import { input } from '../../../test/fixtures/codex-test-helpers.js'

async function closedWorkflow() {
  const replay = new ActivityProductionReplay('continued-workflow')
  const infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Recorded provider I/O required')
  const managers: CodexAppServerSessionManager[] = []
  const createManager = () => {
    const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'scoped', undefined, infrastructure.codex)
    managers.push(manager)
    return manager
  }
  const original = createManager()
  const source = input('/recorded/workflow')
  source.correlationId = `execution:${source.request.executionId}`
  const session = await original.createSession(source)
  await original.close(session)
  const continuation: WorkflowNativeSessionStart = { ...source,
    request: { ...source.request, executionId: 'continued-execution' }, correlationId: 'execution:continued-execution',
    sessionContinuation: { previousExecutionId: source.request.executionId, session } }
  return { replay, session, continuation, createManager,
    close: () => Promise.all(managers.map(manager => manager.dispose())) }
}

it('captures a newly admitted workflow continuation as its own original process lifetime', async () => {
  const f = await closedWorkflow()
  try {
    const manager = f.createManager()
    expect(await manager.createSession(f.continuation)).toEqual(f.session)
    const lifetime = manager.originalSessionLifetime(f.session, f.continuation)
    expect(lifetime).toBeDefined()
    lifetime!.assertCurrent()
    expect(f.replay.threads.size).toBe(1)
    expect(f.replay.starts).toEqual([])
    expect(f.replay.calls.filter(call => call.method === 'thread/resume')).toHaveLength(1)
    expect(await manager.createSession(f.continuation)).toEqual(f.session)
    expect(manager.originalSessionLifetime(f.session, f.continuation)?.residency).toEqual(lifetime!.residency)
    expect(f.replay.calls.filter(call => call.method === 'thread/resume')).toHaveLength(1)
    await manager.close(f.session)
    expect(() => lifetime!.assertCurrent()).toThrow()
  } finally { await f.close() }
})

it.each(['attach', 'create-after-attach'] as const)(
  'keeps cold %s ineligible for original residency even with a continuation descriptor', async mode => {
    const f = await closedWorkflow()
    try {
      const manager = f.createManager()
      expect(await manager.attachSession(f.session, f.continuation)).toEqual(f.session)
      if (mode === 'create-after-attach') expect(await manager.createSession(f.continuation)).toEqual(f.session)
      expect(manager.originalSessionLifetime(f.session, f.continuation)).toBeUndefined()
      expect(f.replay.starts).toEqual([])
    } finally { await f.close() }
  })
