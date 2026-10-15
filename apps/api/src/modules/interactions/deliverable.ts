import { ExecutionResultSchema, type ExecutionResult } from '@foreman-code/contracts'
import {
  OUTPUT_MISMATCH_CODE, OUTPUT_REFERENCE_KEYWORD, OUTPUT_REFERENCE_UNKNOWN_CODE, checkDeliverable, deliverableReferences,
  type DeliverableIssue, type OutputReferenceKind, type OutputSchema,
} from '@foreman-code/contracts/wave25'

/** Where a workflow Agent's deliverable sits in its successful result:
 * text: the plain final answer; data: a choice node's data; latestDeliverable: a handoff or repeat exit's data.latestDeliverable. */
export type DeliverableSource = 'text' | 'data' | 'latestDeliverable'

/** Per-execution deliverable contract. referenceExists answers from app records, scoped to this execution. */
export interface DeliverableContract {
  source: DeliverableSource
  outputSchema?: OutputSchema | undefined
  referenceExists(kind: OutputReferenceKind, value: string): Promise<boolean>
}

export interface DeliverableVerdict {
  code: typeof OUTPUT_MISMATCH_CODE | typeof OUTPUT_REFERENCE_UNKNOWN_CODE
  issues: DeliverableIssue[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Returns undefined when the deliverable passes; otherwise the code and every issue for the repair turn. */
export async function deliverableVerdict(result: ExecutionResult, contract: DeliverableContract): Promise<DeliverableVerdict | undefined> {
  if (result.outcome !== 'succeeded') return undefined
  const output: unknown = result.output
  let value: unknown
  if (contract.source === 'text') {
    const text = isObject(output) && typeof output.text === 'string' ? output.text : undefined
    if (text === undefined) return { code: OUTPUT_MISMATCH_CODE, issues: [{ code: OUTPUT_MISMATCH_CODE, path: '', message: 'The final answer is not text.' }] }
    if (!contract.outputSchema) value = text
    else {
      try {
        value = JSON.parse(text.trim())
      } catch {
        return { code: OUTPUT_MISMATCH_CODE, issues: [{ code: OUTPUT_MISMATCH_CODE, path: '', message: 'The final answer must be one JSON value that matches the output schema.' }] }
      }
    }
  } else {
    const data = isObject(output) ? output.data : undefined
    value = contract.source === 'data' ? data : isObject(data) ? data.latestDeliverable : undefined
  }
  const issues = checkDeliverable(value, contract.outputSchema)
  if (issues.length === 0) {
    for (const reference of deliverableReferences(contract.outputSchema, value)) {
      if (!await contract.referenceExists(reference.kind, reference.value)) {
        issues.push({ code: OUTPUT_REFERENCE_UNKNOWN_CODE, path: reference.path,
          message: `${reference.kind} ${reference.value} was not created by this execution.` })
      }
    }
  }
  if (issues.length === 0) return undefined
  return { code: issues.some(issue => issue.code === OUTPUT_MISMATCH_CODE) ? OUTPUT_MISMATCH_CODE : OUTPUT_REFERENCE_UNKNOWN_CODE, issues }
}

/** One corrective turn in the same native session, listing every validation error exactly. */
export function deliverableRepairPrompt(verdict: DeliverableVerdict, outputSchema: OutputSchema | undefined): string {
  return [
    'Your deliverable failed the workflow output contract.',
    `Validation issues: ${JSON.stringify(verdict.issues)}`,
    'Return the complete corrected final answer. Preserve the valid parts of your deliverable.',
    'This is a corrective turn in the same execution. Do not repeat the task or perform additional work.',
    `Output contract: ${outputSchema ? JSON.stringify(outputSchema) : 'a non-empty deliverable'}`,
  ].join('\n')
}

/** The non-retryable failed result that replaces the Agent's final answer after its repair turns. */
export function deliverableFailure(verdict: DeliverableVerdict): ExecutionResult {
  const detail = verdict.issues.map(issue => `${issue.path || '/'}: ${issue.message}`).join('; ').slice(0, 2000)
  return ExecutionResultSchema.parse({ outcome: 'failed',
    error: { code: verdict.code, message: `The Agent deliverable failed its output contract after repair. ${detail}`, retryable: false } })
}

/** Native structured output for plain text deliverables only. Foreman reference markers are not
 * JSON Schema keywords the model needs, so they are removed before the schema is sent. */
export function nativeOutputSchema(contract: DeliverableContract): Record<string, unknown> | undefined {
  if (contract.source !== 'text' || !contract.outputSchema) return undefined
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (!isObject(node)) return node
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== OUTPUT_REFERENCE_KEYWORD).map(([key, value]) => [key, strip(value)]))
  }
  return strip(contract.outputSchema) as Record<string, unknown>
}
