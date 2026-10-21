/* global process */
import pg from 'pg'

// Observe real driver failures in the isolated Main process; never alter results or retries.
const query = pg.Client.prototype.query
const active = new Map()
pg.Client.prototype.query = function (...args) {
  const pending = Reflect.apply(query, this, args)
  if (!pending || typeof pending.then !== 'function') return pending
  const pid = this.processID
  const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text
  const current = { pid, statement: String(statement).slice(0, 500) }
  active.set(pid, current)
  const finished = () => { if (active.get(pid) === current) active.delete(pid) }
  return pending.then(value => { finished(); return value }, error => {
    if (error.code === '40P01') {
      const detail = String(error.detail ?? '')
      const participants = new Set([...detail.matchAll(/Process (\d+)/g)].map(match => Number(match[1])))
      participants.add(pid)
      process.send?.({ kind: 'postgres-deadlock', detail, where: error.where,
        statements: [...active.values()].filter(value => participants.has(value.pid)) })
    }
    finished()
    throw error
  })
}
