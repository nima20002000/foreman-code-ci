import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { CoordinationResultContext, ExecutionResult, HarnessExecutionContext } from '@foreman-code/contracts'
import { ZodError } from 'zod'
import { parseWorkResultForInput, receivedWorkRequestIds } from '../runs/workHandoffResult.js'
import { parseWorkflowCoordinationResult, parseWorkflowWorkResult } from '../runs/workflowCoordinationResult.js'

/** The JSON of an answer that is not JSON itself but ends with a ```json block, as one compact line. */
function fencedResultJson(result: ExecutionResult): string | undefined {
  const output = result.outcome === 'succeeded' ? result.output : undefined
  const text = output && typeof output === 'object' && !Array.isArray(output) && 'text' in output
    && typeof output.text === 'string' ? output.text.trimEnd() : undefined
  const open = text?.lastIndexOf('```json') ?? -1
  if (!text || open < 0 || !text.endsWith('```')) return undefined
  try {
    JSON.parse(text)
    return undefined
  } catch {
    // ignore: only an answer that is not JSON as a whole can carry its result in a fence.
  }
  try {
    return JSON.stringify(JSON.parse(text.slice(open + 7, -3)))
  } catch {
    return undefined // ignore: a broken block gets the ordinary correction.
  }
}

export function workResultRepairPrompt(result: ExecutionResult, contract: string, input?: unknown,
  context?: HarnessExecutionContext, coordination?: CoordinationResultContext,
  hierarchy?: { version: WorkflowVersionV3; workflowNodeId: string }): string | undefined {
  if (result.outcome !== 'succeeded') return undefined
  try {
    if (coordination) parseWorkflowCoordinationResult(result, coordination, input, context)
    else if (hierarchy) parseWorkflowWorkResult(result, hierarchy.version, hierarchy.workflowNodeId, undefined, input, context)
    else parseWorkResultForInput(result, input, context)
    return undefined
  } catch (error) {
    const issues = error instanceof ZodError ? JSON.stringify(error.issues) : String(error)
    const fenced = fencedResultJson(result)
    return [
      coordination ? 'Your complete result failed the pinned coordinated result contract.'
        : 'Your complete result failed the pinned work-handoff contract.',
      `Validation issues: ${issues}`,
      ...(input === undefined || coordination && (!coordination.definition.handoffs || coordination.interval)
        ? [] : [`Valid open request IDs: ${JSON.stringify(receivedWorkRequestIds(input, context))}`]),
      'Correct the result format and return the complete JSON object again. Preserve your deliverable and findings.',
      ...(fenced ? ['Your answer put the result in a Markdown ```json block. '
        + `Return only this JSON object, unchanged, with no Markdown fences or other text:\n${fenced}`] : []),
      'This is a corrective turn in the same execution. Do not repeat the task or perform additional work.',
      'Expected result shape and saved routing constraints:',
      contract,
    ].join('\n')
  }
}
