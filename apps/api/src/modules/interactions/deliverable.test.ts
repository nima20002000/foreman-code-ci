import { describe, expect, it } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { deliverableFailure, deliverableRepairPrompt, deliverableVerdict, nativeOutputSchema, type DeliverableContract } from './deliverable.js'

const known = new Set(['ticket-created-here'])
const contract = (over: Partial<DeliverableContract> = {}): DeliverableContract => ({
  source: 'text', referenceExists: async (_kind, value) => known.has(value), ...over,
})
const finalText = (text: string): ExecutionResult => ({ outcome: 'succeeded', output: { text } })
const schema = {
  type: 'object', required: ['status', 'summary'],
  properties: { status: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 },
    ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } },
}

describe('deliverable verdict', () => {
  it('passes a non-empty plain answer under the default rule', async () => {
    expect(await deliverableVerdict(finalText('Reviewed the diff.'), contract())).toBeUndefined()
  })

  it('rejects an empty plain answer under the default rule', async () => {
    expect(await deliverableVerdict(finalText('  '), contract())).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
  })

  it('does not judge a failed result', async () => {
    expect(await deliverableVerdict({ outcome: 'failed', error: { code: 'X', message: 'x', retryable: false } }, contract())).toBeUndefined()
  })

  it('requires a declared schema to hold for JSON text and reports the exact paths', async () => {
    const verdict = await deliverableVerdict(finalText('{"status":"done"}'), contract({ outputSchema: schema }))
    expect(verdict?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(verdict?.issues.map(issue => issue.path)).toContain('/summary')
    expect(await deliverableVerdict(finalText('not json'), contract({ outputSchema: schema }))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(finalText('{"status":"done","summary":"Shipped."}'), contract({ outputSchema: schema }))).toBeUndefined()
  })

  it('verifies references only after the shape passes, reporting OUTPUT_REFERENCE_UNKNOWN', async () => {
    const good = await deliverableVerdict(finalText(JSON.stringify({ status: 'done', summary: 'ok', ticket: 'ticket-created-here' })),
      contract({ outputSchema: schema }))
    expect(good).toBeUndefined()
    const unknown = await deliverableVerdict(finalText(JSON.stringify({ status: 'done', summary: 'ok', ticket: 'someone-else' })),
      contract({ outputSchema: schema }))
    expect(unknown).toMatchObject({ code: 'OUTPUT_REFERENCE_UNKNOWN', issues: [{ code: 'OUTPUT_REFERENCE_UNKNOWN', path: '/ticket' }] })
  })

  it('reads a handoff or repeat exit deliverable from data.latestDeliverable', async () => {
    const result: ExecutionResult = { outcome: 'succeeded', output: { routing: { kind: 'finish' }, data: { latestDeliverable: { status: 'done', summary: 'ok' }, remainingFindings: [] } } }
    expect(await deliverableVerdict(result, contract({ source: 'latestDeliverable', outputSchema: schema }))).toBeUndefined()
    const empty: ExecutionResult = { outcome: 'succeeded', output: { routing: { kind: 'finish' }, data: { latestDeliverable: {}, remainingFindings: [] } } }
    expect(await deliverableVerdict(empty, contract({ source: 'latestDeliverable' }))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
  })
})

describe('deliverable repair and failure', () => {
  it('lists every validation issue exactly in the corrective turn', async () => {
    const verdict = await deliverableVerdict(finalText('{}'), contract({ outputSchema: schema }))
    const prompt = deliverableRepairPrompt(verdict!, schema)
    expect(prompt).toContain(JSON.stringify(verdict!.issues))
    expect(prompt).toContain('same execution')
  })

  it('fails loudly with a non-retryable result carrying the code and every issue', async () => {
    const verdict = await deliverableVerdict(finalText('{}'), contract({ outputSchema: schema }))
    expect(deliverableFailure(verdict!)).toMatchObject({ outcome: 'failed',
      error: { code: 'OUTPUT_SCHEMA_MISMATCH', retryable: false } })
  })

  it('sends native structured output only for plain text deliverables, without reference markers', () => {
    expect(nativeOutputSchema(contract({ outputSchema: schema }))).toEqual({
      type: 'object', required: ['status', 'summary'],
      properties: { status: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 }, ticket: { type: 'string' } },
    })
    expect(nativeOutputSchema(contract({ source: 'data', outputSchema: schema }))).toBeUndefined()
    expect(nativeOutputSchema(contract())).toBeUndefined()
  })
})
