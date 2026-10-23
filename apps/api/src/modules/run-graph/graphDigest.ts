import { canonicalGraphJson, type RepeatGraphScopeV3, type RepeatGraphExecutionV3 } from '@foreman-code/contracts/wave25'
import { sha256Hex } from '../../shared/hash.js'

export function graphSourceDigest(value: unknown): string {
  return 'sha256:' + sha256Hex(canonicalGraphJson(value))
}
export function repeatExecutionStateDigest(scope: RepeatGraphScopeV3, execution: RepeatGraphExecutionV3): string {
  return graphSourceDigest({ scope, execution })
}
