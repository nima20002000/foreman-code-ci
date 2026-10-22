#!/usr/bin/env node
// Prints the app error log (web and API errors) grouped by fingerprint, newest first.
// Usage: node scripts/app-errors.mjs [--since 2h|1d|2026-10-22T10:00Z] [--source web|api] [--file path] [--stacks]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  since: { type: 'string' }, source: { type: 'string' }, file: { type: 'string' }, stacks: { type: 'boolean' },
} })
const file = values.file ?? join(process.env.LOG_DIR ?? join(homedir(), '.local/state/graphql-production/logs'), 'app-errors.jsonl')
const units = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const duration = values.since?.match(/^(\d+)([mhd])$/)
const since = !values.since ? 0 : duration ? Date.now() - Number(duration[1]) * units[duration[2]] : Date.parse(values.since)
if (Number.isNaN(since)) throw new Error(`--since must be like 30m, 2h, 1d or a date: ${values.since}`)

const groups = new Map()
for (const path of [`${file}.1`, file].filter(existsSync)) {
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    if (!text) continue
    let entry
    try { entry = JSON.parse(text) } catch {
      continue // ignore: a line cut short by a crash mid-write.
    }
    if (Date.parse(entry.time) < since || (values.source && entry.source !== values.source)) continue
    const group = groups.get(entry.fingerprint) ?? { count: 0, first: entry.time, entry }
    group.count += 1 + (entry.suppressed ?? 0)
    group.last = entry.time
    group.entry = entry
    groups.set(entry.fingerprint, group)
  }
}
if (!groups.size) console.log(`No errors in ${file}${values.since ? ` since ${values.since}` : ''}.`)
for (const { count, first, last, entry } of [...groups.values()].sort((a, b) => b.last.localeCompare(a.last))) {
  const frame = entry.stack?.split('\n').map(line => line.trim()).find(line => line.startsWith('at ') || /@.+:\d+/.test(line))
  const where = [entry.method, entry.status, entry.url].filter(Boolean).join(' ')
  const ids = ['workspaceId', 'workflowId', 'runId'].filter(key => entry[key]).map(key => `${key}=${entry[key]}`).join(' ')
  console.log(`${entry.fingerprint}  ${count}x  ${entry.source}/${entry.kind}${entry.component ? `/${entry.component}` : ''}  first ${first}  last ${last}`)
  console.log(`  ${entry.message.split('\n')[0].slice(0, 300)}`)
  if (frame) console.log(`  ${frame}`)
  if (where || ids) console.log(`  ${[where, ids].filter(Boolean).join('  ')}`)
  if (values.stacks && entry.stack) console.log(entry.stack.replace(/^/gm, '    '))
}
