import { expect, it } from 'vitest'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { databaseDomainError } from './databaseErrors.js'

it.each([
  ['COORDINATION_RESULT_INVALID', 'P0001'], ['COORDINATION_TERMINAL_CONFLICT', 'P0001'],
  ['EXECUTION_SEMANTICS_UNSUPPORTED', 'PGC01'], ['GRAPH_STALE_GENERATION', 'PGA05'],
  ['JOB_VERSION_PIN_CONFLICT', 'P0001'], ['PLACEMENT_ADMISSION_CONFLICT', 'P0001'],
  ['REPEAT_BODY_UNRESOLVED', 'P0001'], ['REPEAT_CARRY_CONFLICT', 'P0001'],
  ['REPEAT_CROSS_OCCURRENCE_JOIN', 'P0001'], ['REPEAT_EGRESS_UNRESOLVED', 'P0001'],
  ['REPEAT_EXECUTION_INPUT_CONFLICT', 'P0001'], ['REPEAT_EXIT_NOT_ACCEPTED', 'P0001'],
  ['REPEAT_LIMIT_EXCEEDED', 'P0001'], ['REPEAT_OUTCOME_UNDECLARED', 'P0001'],
  ['REPEAT_SCOPE_CONFLICT', 'P0001'], ['REPEAT_SUCCESSOR_MISSING', 'P0001'],
  ['WORK_DENIAL_ANCESTRY_CONFLICT', 'P0001'], ['WORK_DIRECTION_WAIT_CONFLICT', 'P0001'],
  ['WORK_ENTRY_PIN_CONFLICT', 'P0001'], ['WORK_JOIN_ROUND_CONFLICT', 'P0001'],
  ['WORK_NOTICE_PIN_CONFLICT', 'P0001'], ['WORK_POLICY_PIN_CONFLICT', 'P0001'],
  ['WORK_REQUEST_ANCESTRY_CONFLICT', 'P0001'], ['WORK_RETURN_ANCESTRY_CONFLICT', 'P0001'],
  ['WORK_RETURN_RESULT_CONFLICT', 'P0001'],
])('maps the raised rule %s and retains its original cause', (code, sqlState) => {
  const cause = Object.assign(new Error(code), { code: sqlState, detail: 'private stored data' })
  const mapped = databaseDomainError(cause)
  expect(mapped).toBeInstanceOf(DomainError)
  expect(mapped).toMatchObject({ code, status: 409, cause })
  expect((mapped as DomainError).message).not.toContain('private stored data')
  expect((mapped as DomainError).details).toBeUndefined()
  expect(databaseDomainError(mapped)).toBe(mapped)
})

it.each([
  Object.assign(new Error('REPEAT_SCOPE_CONFLICT'), { code: '23514' }),
  Object.assign(new Error('REPEAT_SCOPE_CONFLICT'), { code: '40001' }),
  Object.assign(new Error('GRAPH_STALE_GENERATION'), { code: 'P0001' }),
  Object.assign(new Error('EXECUTION_SEMANTICS_UNSUPPORTED'), { code: 'P0001' }),
  Object.assign(new Error('REPEAT_SCOPE_CONFLICT: private stored data'), { code: 'P0001' }),
  Object.assign(new Error('UNKNOWN_RULE'), { code: 'P0001' }),
  Object.assign(new Error('toString'), { code: 'P0001' }),
  new Error('REPEAT_SCOPE_CONFLICT'),
  { message: 'REPEAT_SCOPE_CONFLICT', code: 'P0001' }, null, undefined,
])('preserves unknown failures without guessing a domain rule: %s', error => {
  expect(databaseDomainError(error)).toBe(error)
})
