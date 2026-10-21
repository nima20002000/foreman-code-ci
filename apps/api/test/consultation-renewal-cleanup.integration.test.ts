import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('consultation setup renewal cleanup', () => {
  it('does not renew a revoked setup credential after a capacity lookup fails', async () => {
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}))
    let failLookup = false
    let injected = false
    const f = await currentOperatorIntegration({ fixture: hierarchyRuntimeFixture(), executionChat: true,
      approvalNodeIds: [], collaborationPorts: {}, credentialTtlMs: 60_000, managerFactory: context => {
        const manager = provider.connection(context)
        if (context.purpose === 'consultation' && !injected) {
          const attach = manager.attachSession.bind(manager)
          manager.attachSession = async (...args) => {
            const session = await attach(...args)
            failLookup = true
            return session
          }
        }
        return manager
      } })
    const snapshot = f.runs.getRepeatSnapshot.bind(f.runs)
    vi.spyOn(f.runs, 'getRepeatSnapshot').mockImplementation(async (...args) => {
      if (failLookup) {
        failLookup = false
        injected = true
        throw new Error('The snapshot database read failed')
      }
      return snapshot(...args)
    })
    const renewal = vi.spyOn(WorkerCredentialService.prototype, 'renewForConsultation')
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, 'master')
      expect(await workflowChatCall(f, 'agent_chat_send', { commandId: 'failed-setup', target,
        intent: 'next_turn', content: 'Explain the pending work', attachments: [] })).toMatchObject({
        state: 'failed', errorCode: 'CONSULTATION_PREPARATION_FAILED',
      })
      expect(injected).toBe(true)
      expect(provider.consultations).toEqual([])
      expect((await f.db.pool.query("select principal_id from worker_credential_bindings where run_id=$1 and purpose='consultation' and revoked_at is null",
        [f.f.run.id])).rows).toEqual([])
      // The accepted one-minute test lease uses the unchanged production one-second renewal floor.
      await delay(1_200)
      expect(renewal).not.toHaveBeenCalled()
      expect(await workflowChatCall(f, 'agent_chat_send', { commandId: 'after-failure', target,
        intent: 'next_turn', content: 'Explain current progress', attachments: [] })).not.toMatchObject({ state: 'failed' })
      await expect.poll(() => provider.consultations.length).toBe(1)
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)
})
