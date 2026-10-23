import { expect, it } from 'vitest'
import { RunExecutionStateSchema, type RunExecutionState } from '@foreman-code/contracts'
import { CLOSED_RUN_STATES, IN_PROGRESS_RUN_STATES, OPEN_RUN_STATES, RUN_INITIAL_STATE, RUN_STATE_TRANSITIONS,
  canTransitionRun, isClosedRunState, isOpenRunState, isRunInProgress, writeRunStateLocked } from './runState.js'

const states = RunExecutionStateSchema.options

function recordingSql() {
  const writes: unknown[][] = []
  return { writes, sql: { query: async (_text: string, values?: unknown[]) => { writes.push(values ?? []); return { rowCount: 1, rows: [] } } } as never }
}

it('lets a Run move only along the lifecycle the engine performs', () => {
  // Start, approval or direction wait, resume, success, negative settlement and settling an older interrupted Run.
  const performed: Array<[RunExecutionState, RunExecutionState]> = [
    ['queued', 'running'], ['running', 'waiting'], ['waiting', 'running'], ['running', 'completed'], ['waiting', 'completed'],
    ['queued', 'completed'], ['interrupted', 'completed']]
  for (const [from, to] of performed) expect(canTransitionRun(from, to), `${from} -> ${to}`).toBe(true)
  const allowed = states.flatMap(from => RUN_STATE_TRANSITIONS[from].map(to => `${from}->${to}`)).sort()
  expect(allowed).toEqual(performed.map(([from, to]) => `${from}->${to}`).sort())
  expect(RUN_STATE_TRANSITIONS.completed).toEqual([])
  expect(RUN_INITIAL_STATE).toBe('queued')
})

it('writes a Run state only for an allowed transition', async () => {
  const allowed = recordingSql()
  await expect(writeRunStateLocked(allowed.sql, 'waiting', { id: 'run-1', executionState: 'running' }, '{}')).resolves.toBe(1)
  expect(allowed.writes).toEqual([['run-1', 'running', '{}']])
  for (const from of states) {
    for (const to of states) {
      if (canTransitionRun(from, to)) continue
      const refused = recordingSql()
      await expect(writeRunStateLocked(refused.sql, from, { id: 'run-1', executionState: to }, '{}'))
        .rejects.toMatchObject({ code: 'RUN_STATE_TRANSITION_INVALID', status: 409 })
      expect(refused.writes).toEqual([])
    }
  }
})

it('classifies every Run state as exactly one of closed or open', () => {
  for (const state of states) expect(isClosedRunState(state)).toBe(!isOpenRunState(state))
  expect([...CLOSED_RUN_STATES, ...OPEN_RUN_STATES].sort()).toEqual([...states].sort())
  expect(IN_PROGRESS_RUN_STATES.every(isOpenRunState)).toBe(true)
  expect(states.filter(isRunInProgress)).toEqual(['running', 'waiting'])
  expect(isClosedRunState(undefined)).toBe(false)
  expect(isOpenRunState(null)).toBe(false)
})
