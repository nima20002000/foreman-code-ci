import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { beforeGraphCommit, beforeGraphCommitChecks, ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'

/** A database session that only remembers how its last transaction ended. */
function connection() {
  let outcome: 'open' | 'committed' | 'rolled back' | undefined
  const ends = { commit: 'committed', rollback: 'rolled back' } as const
  const client = { query: async (text: string) => {
    outcome = text in ends ? ends[text as keyof typeof ends] : outcome ?? 'open'
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase
  return { connection: new ExclusiveGraphConnection(client, () => {}), outcome: () => outcome }
}

describe('adjacent read-only graph commit checks', () => {
  it('checks every captured expectation against one live read for an adjacent group', async () => {
    const t = connection(), owner = {}
    let current = 'original'
    const verify = vi.fn(async (expected: readonly string[]) => {
      if (expected.some(value => value !== current)) throw new Error('fence changed')
    })
    try {
      await expect(t.connection.transaction(async sql => {
        beforeGraphCommitChecks(sql, owner, 'original', verify)
        beforeGraphCommitChecks(sql, owner, 'different', verify)
        current = 'original'
      })).rejects.toThrow('fence changed')
      expect(verify).toHaveBeenCalledExactlyOnceWith(['original', 'different'])
      expect(t.outcome()).toBe('rolled back')
    } finally { await t.connection.close() }
  })
  it('keeps separate live checks on both sides of an intervening finalizer', async () => {
    const t = connection(), owner = {}, order: string[] = []
    let current = 'original'
    const verify = async (expected: readonly string[]) => {
      order.push('check')
      if (expected.some(value => value !== current)) throw new Error('fence changed')
    }
    try {
      await expect(t.connection.transaction(async sql => {
        beforeGraphCommitChecks(sql, owner, 'original', verify)
        beforeGraphCommit(sql, async () => { order.push('mutation'); current = 'replacement' })
        beforeGraphCommitChecks(sql, owner, 'original', verify)
      })).rejects.toThrow('fence changed')
      expect(order).toEqual(['check', 'mutation', 'check'])
      expect(t.outcome()).toBe('rolled back')
    } finally { await t.connection.close() }
  })
})
