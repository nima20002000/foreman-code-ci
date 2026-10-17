import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { OUTPUT_SCHEMA_MAX_BYTES } from '@foreman-code/contracts/wave25'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'
import { readUntil } from '../../../../test/helpers/observableCondition.js'

const outputSchema = { type: 'object', properties: { summary: { type: 'string' } },
  required: ['summary'], additionalProperties: false }

describe('Worker output validation', () => {
  it('forwards the schema from Main and journals its identity across replay and reopen', async () => {
    const f = await runningInstalledFixture('generation', { deferTurn: true })
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
      harness: 'codex', configuration: f.request.configuration, observeReceipt: async () => {},
      controlFor: async () => { throw new Error('No controls expected') },
      transport: { request: async (method, payload) => {
        const frame = RemoteExecutionRpcRequestSchema.parse(payload)
        const reply = await f.call(method, { ...frame, executionPlacement: f.nativePlacement })
        if (method === 'start-turn') f.finish('succeeded', { text: '{"summary":"Done"}' })
        return reply.payload
      } } })
    try {
      const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution',
        environment: { agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'original-token' } } })
      for await (const event of proxy.startTurn(session, {
        prompt: 'original prompt', clientCorrelationId: 'execution:execution', outputSchema,
      })) expect(event).toHaveProperty('sequence')
      expect(f.turns.mock.calls[0]![1].outputSchema).toEqual(outputSchema)
      await f.settled
      const outputSchemaDigest = createHash('sha256').update(canonicalJson(outputSchema)).digest('hex')
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ receipt: {
        turnInput: { outputSchemaDigest },
      } })
      await f.call('start-turn', { prompt: 'original prompt', correlationId: 'execution:execution', outputSchema })
      await expect(f.call('start-turn', { prompt: 'original prompt', correlationId: 'execution:execution',
        outputSchema: { ...outputSchema, required: [] } })).rejects.toThrow('binding conflict')
      expect(f.turns).toHaveBeenCalledTimes(1)
      await f.host.close()
      await f.journal.close()
      const reopened = await RemoteOperationJournal.open(join(f.root, 'workflow-journal'))
      try {
        expect(await reopened.status(f.intent.operationId)).toMatchObject({ receipt: {
          turnInput: { outputSchemaDigest },
        } })
      } finally { await reopened.close() }
    } finally {
      f.finish('succeeded')
      await f.host.close()
    }
  })

  it('retains the native owner until Main finishes validation', async () => {
    const f = await runningInstalledFixture('generation', { deferTurn: true })
    try {
      await f.call('start-turn', { prompt: 'original prompt', correlationId: 'execution:execution',
        deferSettlement: true })
      f.finish('succeeded', { text: 'answer to validate' })
      await readUntil(async () => (await f.call('history', { correlationId: 'execution:execution' })).payload,
        value => Boolean((value as { history?: { terminalTurn?: unknown } }).history?.terminalTurn),
        { timeoutMs: 2000, description: 'provider result awaiting Main validation' })
      expect(f.closeOwner).not.toHaveBeenCalled()
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ receipt: { phase: 'running' } })
      await f.call('settle-turn', { correlationId: 'execution:execution', nativeTurnId: 'original-turn' })
      await f.settled
      expect(f.closeOwner).toHaveBeenCalledTimes(1)
      await f.call('settle-turn', { correlationId: 'execution:execution', nativeTurnId: 'original-turn' })
      expect(f.closeOwner).toHaveBeenCalledTimes(1)
    } finally {
      f.finish('succeeded')
      await f.host.close()
    }
  })

  it('rejects oversized schemas before native submission', async () => {
    const f = await runningInstalledFixture('generation', { deferTurn: true })
    try {
      await expect(f.call('start-turn', { prompt: 'original prompt', correlationId: 'execution:execution',
        outputSchema: { ...outputSchema, description: 'x'.repeat(OUTPUT_SCHEMA_MAX_BYTES) } })).rejects.toThrow()
      expect(f.turns).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  })
})
