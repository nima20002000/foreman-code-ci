import {
  CANONICAL_RUN_GRAPH_ROUTES, RepeatGraphCurrentStateSchema, RepeatGraphReadRequestCurrentSchema,
  canonicalGraphJson, sameCanonicalGraphScope, type RepeatGraphCurrentState, type RepeatGraphScopeCurrent,
} from '@foreman-code/contracts/current'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../shared/api/client'

/** v3 is not negotiated through, or coerced into, the legacy graph reader. */
export function repeatCurrentPath(scope: RepeatGraphScopeCurrent): string {
  const request = RepeatGraphReadRequestCurrentSchema.parse({ protocolVersion: 1, scope })
  const path = CANONICAL_RUN_GRAPH_ROUTES.current
    .replace(':workspaceId', encodeURIComponent(request.scope.workspaceId))
    .replace(':workflowId', encodeURIComponent(request.scope.workflowId))
    .replace(':runId', encodeURIComponent(request.scope.runId))
  return `${path}?${new URLSearchParams({ workflowVersionId: request.scope.workflowVersionId, executionSemanticsVersion: '3' })}`
}

export function assertRepeatCurrentProgress(previous: RepeatGraphCurrentState | undefined, next: RepeatGraphCurrentState): void {
  if (!previous) return
  if (!sameCanonicalGraphScope(previous.scope, next.scope)
    || BigInt(next.asOfSequence) < BigInt(previous.asOfSequence)
    || canonicalGraphJson(previous.topology) !== canonicalGraphJson(next.topology)
    || previous.state.run.stopRequested && !next.state.run.stopRequested
    || previous.asOfSequence === next.asOfSequence && canonicalGraphJson(previous.state) !== canonicalGraphJson(next.state)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The canonical Run read changed immutable pins or regressed its complete cut.' })
  }
}

export function createRepeatGraphClient(client: ApiClient = apiClient) {
  return {
    async current(scope: RepeatGraphScopeCurrent, options?: RequestOptions): Promise<RepeatGraphCurrentState> {
      const value = await client.request(repeatCurrentPath(scope), RepeatGraphCurrentStateSchema, options)
      // Check the envelope even when there are ZERO occurrence rows.
      if (!sameCanonicalGraphScope(value.scope, scope)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The canonical graph did not match the selected immutable Run/version.' })
      }
      return value
    },
  }
}
export type RepeatGraphClient = ReturnType<typeof createRepeatGraphClient>
export const repeatGraphClient = createRepeatGraphClient()
