import { COORDINATION_RESULT_PROTOCOL, parseCoordinationResult,
  type HandoffCoordinationResultSchema, type ResultProtocol } from '@foreman-code/contracts'
import { ExecutionResultSchema } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { z } from 'zod'
import { DomainError } from '../errors.js'

export type HierarchyWorkResult = z.infer<typeof HandoffCoordinationResultSchema>

export function isHierarchyProtocol(version: WorkflowVersionV3, resultProtocol: ResultProtocol | undefined): boolean {
  return version.definition.hierarchy !== undefined && resultProtocol === COORDINATION_RESULT_PROTOCOL
}

/** Only the immutable Run marker selects the coordinated result parser.
 * Admission keeps that marker off until the complete F1 callback integration. */
export function parseHierarchyWorkResult(result: unknown, version: WorkflowVersionV3,
  workflowNodeId: string, resultProtocol: ResultProtocol | undefined,
  outstandingRequestIds?: readonly string[]): HierarchyWorkResult {
  if (!version.definition.hierarchy || !version.definition.handoffs) {
    throw new DomainError('HIERARCHY_REQUIRED', 'This saved workflow does not have a hierarchy.', 409)
  }
  if (resultProtocol !== COORDINATION_RESULT_PROTOCOL) {
    throw new DomainError('HIERARCHY_RESULT_PROTOCOL_UNAVAILABLE',
      'Hierarchy result processing requires the integrated Run result protocol.', 409)
  }
  const native = ExecutionResultSchema.parse(result)
  if (native.outcome !== 'succeeded') throw new DomainError('HIERARCHY_RESULT_NOT_SUCCESSFUL',
    'A failed or canceled native execution cannot supply a work return.', 409)
  const parsed = parseCoordinationResult(native.output, { resultProtocol,
    definition: version.definition, workflowNodeId,
    ...(outstandingRequestIds ? { outstandingRequestIds } : {}) })
  if (!('routing' in parsed) || !('kind' in parsed.routing)) {
    throw new DomainError('HIERARCHY_RESULT_ROUTING_REQUIRED', 'A hierarchy result requires work routing.', 409)
  }
  return parsed as HierarchyWorkResult
}
