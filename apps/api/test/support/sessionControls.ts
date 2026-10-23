import type pg from 'pg'
import { SessionControlStateSchema, type SessionControlState } from '@foreman-code/contracts'
import { SessionControlStore } from '../../src/modules/conversations/sessionControls/store.js'

export function memorySessionControlPool(options: {
  records?: Map<string, SessionControlState>
  defaults?: Map<string, unknown>
} = {}) {
  const records = options.records ?? new Map<string, SessionControlState>()
  const defaults = options.defaults ?? new Map<string, unknown>()
  const pool = {
    // The store's statements are told apart by what they bind, not by their text: one value reads a control record; two
    // either read compaction history (a command operation second) or create a record (its JSON second); three either
    // save with an expected revision (a number third) or merge a patch for a profile (a profile key third); four read
    // saved defaults; eight save a record together with the defaults it was saved under.
    async query(_text: string, values: unknown[] = []) {
      const id = String(values[0])
      const previous = records.get(id)
      const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount })
      if (values.length === 4) {
        const record = defaults.get(JSON.stringify(values))
        return result(record ? [{ record }] : [])
      }
      if (values.length === 2 && (values[1] === 'operator_chat_control' || values[1] === 'agent_chat_control')) return result()
      if (values.length === 8) {
        if (!previous || previous.revision !== Number(values[2])) return result()
        const next = SessionControlStateSchema.parse(JSON.parse(String(values[1])))
        if (previous.profileKey === next.profileKey) next.context = previous.context
        records.set(id, next)
        defaults.set(JSON.stringify(values.slice(3, 7)), JSON.parse(String(values[7])))
        return result([], 1)
      }
      if (values.length === 1) return result(previous ? [{ record: previous }] : [])
      if (values.length === 2) {
        if (previous) return result()
        records.set(id, SessionControlStateSchema.parse(JSON.parse(String(values[1]))))
        return result([], 1)
      }
      if (values.length === 3 && typeof values[2] === 'number') {
        if (!previous || previous.revision !== Number(values[2])) return result()
        const next = SessionControlStateSchema.parse(JSON.parse(String(values[1])))
        if (previous.profileKey === next.profileKey) next.context = previous.context
        records.set(id, next)
        return result([], 1)
      }
      if (values.length === 3) {
        if (!previous || previous.profileKey !== String(values[2])) return result()
        const patch = JSON.parse(String(values[1])) as Partial<SessionControlState>
        const next = SessionControlStateSchema.parse({ ...previous, ...patch })
        records.set(id, next)
        return result([{ record: next }])
      }
      throw new Error(`Unhandled session controls fixture query binding ${values.length} values`)
    },
  } as unknown as Pick<pg.Pool, 'query'>
  return pool
}

export function memorySessionControls(role: 'operator' | 'agent' = 'operator') {
  return new SessionControlStore(memorySessionControlPool(), role)
}
