import { canonicalGraphJson, type RepeatGraphScopeCurrent, type RepeatGraphExecutionCurrent } from '@foreman-code/contracts/current'
import { sha256Hex } from '../../shared/hash.js'

export function graphSourceDigest(value: unknown): string {
  return 'sha256:' + sha256Hex(canonicalGraphJson(value))
}
export function repeatExecutionStateDigest(scope: RepeatGraphScopeCurrent, execution: RepeatGraphExecutionCurrent): string {
  return graphSourceDigest({ scope, execution })
}
