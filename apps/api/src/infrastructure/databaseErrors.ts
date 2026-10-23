import { DomainError } from '@foreman-code/contracts/server-kit'

const repeatRules = new Set([
  'COORDINATION_TERMINAL_CONFLICT',
  'REPEAT_BODY_UNRESOLVED', 'REPEAT_CARRY_CONFLICT', 'REPEAT_CROSS_OCCURRENCE_JOIN',
  'REPEAT_EGRESS_UNRESOLVED', 'REPEAT_EXECUTION_INPUT_CONFLICT', 'REPEAT_EXIT_NOT_ACCEPTED',
  'REPEAT_LIMIT_EXCEEDED', 'REPEAT_OUTCOME_UNDECLARED', 'REPEAT_SCOPE_CONFLICT', 'REPEAT_SUCCESSOR_MISSING',
  'WORK_DENIAL_ANCESTRY_CONFLICT', 'WORK_DIRECTION_WAIT_CONFLICT', 'WORK_ENTRY_PIN_CONFLICT',
  'WORK_JOIN_ROUND_CONFLICT', 'WORK_NOTICE_PIN_CONFLICT', 'WORK_POLICY_PIN_CONFLICT',
  'WORK_REQUEST_ANCESTRY_CONFLICT', 'WORK_RETURN_ANCESTRY_CONFLICT', 'WORK_RETURN_RESULT_CONFLICT',
])
const messages: Record<string, string> = {
  COORDINATION_RESULT_INVALID: 'The result did not satisfy the saved coordination protocol.',
  EXECUTION_SEMANTICS_UNSUPPORTED: 'Only explicitly pinned current execution semantics 3 can be read.',
  GRAPH_STALE_GENERATION: 'The graph request could not be completed safely.',
  JOB_VERSION_PIN_CONFLICT: 'The saved job version differs from the accepted workflow.',
  PLACEMENT_ADMISSION_CONFLICT: 'The selected root and enabled harness instance must be available on the selected computer.',
}

/** Translate only known raised rules, after rollback. SQLSTATE and the entire message must match;
 * constraint errors, arbitrary SQL messages and application errors keep their original identity. */
export function databaseDomainError(error: unknown): unknown {
  if (error instanceof DomainError || !(error instanceof Error) || !('code' in error)) return error
  const code = error.message
  const sqlState = code === 'GRAPH_STALE_GENERATION' ? 'PGA05'
    : code === 'EXECUTION_SEMANTICS_UNSUPPORTED' ? 'PGC01' : 'P0001'
  if (error.code !== sqlState) return error
  const message = repeatRules.has(code) ? 'The repeat operation conflicts with its pinned durable evidence.'
    : Object.hasOwn(messages, code) ? messages[code] : undefined
  return message ? new DomainError(code, message, 409, undefined, { cause: error }) : error
}
