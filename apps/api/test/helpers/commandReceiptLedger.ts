import { vi } from 'vitest'

interface Receipt { target_key: unknown; input_hash: unknown; result: unknown }

/** An in-memory command receipt table for the conversation control commands (NativeConversationControlCommands). The
 * three receipt statements are told apart by how many values each binds (claim 7, settle 6, read 3), not by their SQL
 * text. This is a substitute for fault injection only, not PostgreSQL proof. */
export function commandReceiptLedger() {
  const records = new Map<string, Receipt>()
  let failSettlement = false
  const query = vi.fn(async (_statement: string, values: unknown[]) => {
    const key = JSON.stringify(values.slice(0, 3))
    if (values.length === 7) {
      if (records.has(key)) return { rowCount: 0, rows: [] }
      records.set(key, { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[6])) })
      return { rowCount: 1, rows: [] }
    }
    if (values.length === 6) {
      if (failSettlement) throw new Error('connection lost after native effect')
      records.get(key)!.result = JSON.parse(String(values[3]))
      return { rowCount: 1, rows: [] }
    }
    if (values.length === 3) return { rowCount: 1, rows: [records.get(key)] }
    throw new Error(`Unexpected receipt statement binding ${values.length} values`)
  })
  return { records, query, failSettlement: () => { failSettlement = true } }
}
