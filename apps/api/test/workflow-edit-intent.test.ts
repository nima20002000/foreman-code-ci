import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { CurrentJournalRunPinSchema, type CurrentJournalRunState } from '@foreman-code/contracts/current'
import { currentSaveAdmissionFixture } from './helpers/currentSaveAdmission.js'
import { readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { sameAffectedSet } from '../src/modules/graph-drafts/durableEditIntent.js'

const { pin, row } = currentSaveAdmissionFixture('edit-intent')
const settled: CurrentJournalRunState = { pin, terminal: true, settled: true, outcome: 'succeeded',
  nativePending: false, cleanupPending: false, interactionPending: false, reviewPending: false }
const scope = { workspaceId: pin.workspaceId, workflowId: pin.workflowId, stagedAgentIds: ['shared'] }

describe('exact affected-set and current settlement mapping', () => {
  it('keeps outcome changes independent of immutable accepted identities', () => {
    expect(sameAffectedSet({ affected: [pin] }, [settled])).toBe(true)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, outcome: 'failed' }])).toBe(true)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, settled: false }])).toBe(true)
  })
  it.each(['runId', 'workflowId', 'workflowVersionId', 'workspaceId'] as const)('rejects changed %s even after terminal settlement', (field) => {
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, [field]: 'other' } }])).toBe(false)
  })
  it('rejects added/missing Runs and changed Agent or semantics pins', () => {
    expect(sameAffectedSet({ affected: [pin] }, [])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [settled, { ...settled, pin: { ...pin, runId: 'new' } }])).toBe(false)
    const retired = { ...settled, pin: { ...pin, executionSemanticsVersion: 2 } }
    expect(CurrentJournalRunPinSchema.safeParse(retired.pin).success).toBe(false)
    // Deliberately corrupted persisted input: the comparator must not erase
    // the pin difference even before the current journal parser rejects it.
    expect(sameAffectedSet({ affected: [pin] }, [retired as unknown as CurrentJournalRunState])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, agentConfigurationVersionIds: { agent: 'new' } } }])).toBe(false)
  })
  it('returns the exact settled affected Run without modifying its snapshot', async () => {
    const before = structuredClone(row)
    // The canonical native page has only a Run id and cursor; this fixture has no executions.
    const query = vi.fn(async (_text: string, values: unknown[] = []) => values.length === 2
      ? { rows: [], rowCount: 0 } : { rows: [structuredClone(row)], rowCount: 1 })
    expect(await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope)).toEqual([settled])
    expect(row).toEqual(before)
  })
  it.each(['cleanup', 'native', 'interactions', 'reviews'] as const)('waits beyond terminal on %s, including absent evidence', async (field) => {
    for (const value of [true, null, undefined]) {
      const query = vi.fn(async () => ({ rows: [{ ...row, [field]: value }], rowCount: 1 }))
      const [state] = await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope)
      expect(state?.terminal).toBe(true); expect(state?.settled).toBe(false)
    }
  })
  it('does not promote unknown terminal evidence to settled', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row, terminal: undefined }], rowCount: 1 }))
    expect((await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope))[0]?.settled).toBe(false)
  })
})
