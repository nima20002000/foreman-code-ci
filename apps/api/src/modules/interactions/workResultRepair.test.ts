import { describe, expect, it } from 'vitest'
import { parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { ZodError } from 'zod'
import { currentInitialPrompt } from '../runs/currentRouting.js'
import { workResultRepairPrompt } from './workResultRepair.js'

const contract = currentInitialPrompt({}, false, true)!
const valid = { routing: { kind: 'finish' }, data: { latestDeliverable: 'Done', remainingFindings: [] } }

describe('work result repair instructions', () => {
  it('includes the exact validation issues and expected shape for the reported finish outcome', () => {
    const result = { outcome: 'succeeded' as const,
      output: { ...valid, routing: { kind: 'finish', outcome: 'Run the check.' } } }
    let issues: unknown
    try {
      parseWorkHandoffResult(result)
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      issues = error.issues
    }
    expect(issues).toBeDefined()
    const prompt = workResultRepairPrompt(result, contract)
    expect(prompt).toContain(`Validation issues: ${JSON.stringify(issues)}`)
    expect(prompt).toContain(contract)
    expect(prompt).toContain('{"kind":"finish"}')
  })

  it.each([
    { ...valid, routing: { kind: 'finish', unexpected: true } },
    { ...valid, data: { latestDeliverable: null, remainingFindings: [] } },
    `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
    `${JSON.stringify(valid)} commentary`,
    { text: JSON.stringify(valid), other: true },
    'x'.repeat(65537),
  ])('requests a correction without accepting or rewriting invalid output', output => {
    const result = { outcome: 'succeeded' as const, output }
    expect(workResultRepairPrompt(result, contract)).toContain('Validation issues:')
    expect(() => parseWorkHandoffResult(result)).toThrow()
  })

  it('hands back the JSON of an answer that ended in a ```json block, to be returned bare', () => {
    const text = `I checked 4 pages:\n\n1. **Paris** - "a city"\n\n\`\`\`json\n${JSON.stringify(valid, null, 2)}\n\`\`\`\n`
    const prompt = workResultRepairPrompt({ outcome: 'succeeded', output: { text } }, contract)
    expect(prompt).toContain(`Return only this JSON object, unchanged, with no Markdown fences or other text:\n${JSON.stringify(valid)}`)
    expect(workResultRepairPrompt({ outcome: 'succeeded', output: { text: '```json\n{"data":\n```' } }, contract))
      .not.toContain('Return only this JSON object')
  })

  it('accepts supported carriers and leaves native failure and cancellation alone', () => {
    for (const output of [valid, JSON.stringify(valid), { text: JSON.stringify(valid) }]) {
      expect(workResultRepairPrompt({ outcome: 'succeeded', output }, contract)).toBeUndefined()
    }
    expect(workResultRepairPrompt({ outcome: 'failed', error: {
      code: 'NATIVE_ERROR', message: 'Native failure', retryable: false,
    } }, contract))
      .toBeUndefined()
    expect(workResultRepairPrompt({ outcome: 'canceled' }, contract)).toBeUndefined()
  })
})
