import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { projectRunChatTranscript } from './runChatTranscript.js'

const fixture = makeCurrentWorkflowFixture('execution-transcript', 'single')
const execution = HarnessExecutionSchema.parse({
  id: 'execution-transcript', runId: fixture.run.id, workflowNodeId: fixture.version.definition.nodes[0]!.id,
  agentId: fixture.configurations[0]!.agentId, agentConfigurationVersionId: fixture.configurations[0]!.id,
  attempt: 1, input: {}, state: 'running', createdAt: fixture.createdAt,
})
const row = (sequence: number, content = `Message ${sequence}`) => ({
  item_key: `item-${sequence}`, role: 'assistant' as const, content, original_bytes: Buffer.byteLength(content),
  complete: false, sequence: String(sequence), revision: String(sequence),
})

it('reads an execution without public text at revision zero', () => {
  expect(projectRunChatTranscript(execution, [])).toEqual({
    executionId: execution.id,
    state: execution.state,
    revision: '0',
    messages: [],
    hasEarlierMessages: false,
  })
})

it('preserves the first native event sequence and revision when they start at zero', () => {
  const result = projectRunChatTranscript(execution, [row(0)])
  expect(result.revision).toBe('0')
  expect(result.messages).toMatchObject([{ sequence: '0', revision: '0', content: 'Message 0' }])
})

it('keeps execution identity, partial text and chronological order without fabricating a conversation', () => {
  const result = projectRunChatTranscript(execution, [row(1), { ...row(2), complete: true }])
  expect(result).toMatchObject({ executionId: execution.id, state: 'running', revision: '3',
    messages: [{ content: 'Message 1', nativeMessageComplete: false },
      { content: 'Message 2', nativeMessageComplete: true }] })
  expect(result.messages.every(message => !('conversationId' in message))).toBe(true)
})

it('returns an empty transcript and advances its revision when the first native message arrives', () => {
  const empty = projectRunChatTranscript(execution, [])
  expect(empty).toEqual({ executionId: execution.id, state: 'running', revision: '1',
    messages: [], hasEarlierMessages: false })

  const first = projectRunChatTranscript(execution, [row(1)])
  expect(first.revision).toBe('2')
  expect(BigInt(first.revision)).toBeGreaterThan(BigInt(empty.revision))
  expect(first.messages[0]).toMatchObject({ content: 'Message 1', sequence: '1', revision: '1' })
})

it('bounds history and text while exposing truncation and redacting retained application credentials', () => {
  const credential = `opm_${'a'.repeat(43)}`
  const rows = Array.from({ length: 101 }, (_, index) => row(index + 1, '🙂'.repeat(9000)))
  rows[100] = row(101, `Saved ${credential}`)
  const result = projectRunChatTranscript(execution, rows)
  expect(result.hasEarlierMessages).toBe(true)
  expect(result.messages).toHaveLength(100)
  expect(result.messages.at(-1)?.content).toBe('Saved [REDACTED]')
  expect(result.messages.map(message => message.content).join('')).not.toContain(credential)
  expect(result.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0)).toBeLessThanOrEqual(128 * 1024)
  expect(result.messages.some(message => message.truncation?.originalBytes === 36000)).toBe(true)
  expect(result.messages.every(message => !message.content.includes('�'))).toBe(true)
})
