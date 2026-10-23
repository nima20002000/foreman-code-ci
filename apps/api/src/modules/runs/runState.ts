import type { RunExecutionState } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

/*
 * The Run state machine. A Run is created `queued`, runs, may wait for an approval or for owner direction, and is
 * settled `completed` with an outcome. `interrupted` is a closed state older Runs may still hold; settlement turns it
 * into `completed`. Every write of `runs.execution_state` goes through `writeRunStateLocked`, which refuses a
 * transition this table does not allow.
 */

export const RUN_INITIAL_STATE = 'queued' satisfies RunExecutionState

/** Allowed transitions: from state → states it may move to. */
export const RUN_STATE_TRANSITIONS: Readonly<Record<RunExecutionState, readonly RunExecutionState[]>> = {
  queued: ['running', 'completed'],
  running: ['waiting', 'completed'],
  waiting: ['running', 'completed'],
  interrupted: ['completed'],
  completed: [],
}

/** A closed Run accepts no more work. */
export const CLOSED_RUN_STATES = ['completed', 'interrupted'] as const satisfies readonly RunExecutionState[]
/** An open Run is queued or in progress. */
export const OPEN_RUN_STATES = ['queued', 'running', 'waiting'] as const satisfies readonly RunExecutionState[]
/** An in-progress Run has started and is not closed: it is running or waiting. */
export const IN_PROGRESS_RUN_STATES = ['running', 'waiting'] as const satisfies readonly RunExecutionState[]

const includes = (states: readonly string[], state: string | null | undefined) => state !== null && state !== undefined && states.includes(state)
export const isClosedRunState = (state: string | null | undefined): boolean => includes(CLOSED_RUN_STATES, state)
export const isOpenRunState = (state: string | null | undefined): boolean => includes(OPEN_RUN_STATES, state)
export const isRunInProgress = (state: string | null | undefined): boolean => includes(IN_PROGRESS_RUN_STATES, state)

/** A SQL list of states for `execution_state in (...)` predicates, e.g. `'completed','interrupted'`. */
export function sqlRunStates(states: readonly RunExecutionState[]): string {
  return states.map(state => `'${state}'`).join(',')
}

/** SQL lists for `execution_state in (...)` predicates. */
export const CLOSED_RUN_STATES_SQL = sqlRunStates(CLOSED_RUN_STATES)
export const OPEN_RUN_STATES_SQL = sqlRunStates(OPEN_RUN_STATES)
export const IN_PROGRESS_RUN_STATES_SQL = sqlRunStates(IN_PROGRESS_RUN_STATES)

export function canTransitionRun(from: RunExecutionState, to: RunExecutionState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to)
}

export function assertRunTransition(from: RunExecutionState, to: RunExecutionState): void {
  if (!canTransitionRun(from, to)) {
    throw new DomainError('RUN_STATE_TRANSITION_INVALID', `A ${from} Run cannot become ${to}.`, 409)
  }
}

/**
 * Writes a Run's new state and record under the caller's Run lock, after checking the transition. Returns the
 * number of rows written, so the caller keeps its own conflict handling.
 */
export async function writeRunStateLocked(sql: SqlQuery, from: RunExecutionState,
  next: { id: string; executionState: RunExecutionState }, record: string): Promise<number> {
  assertRunTransition(from, next.executionState)
  const changed = await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [next.id, next.executionState, record])
  return changed.rowCount ?? 0
}
