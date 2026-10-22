import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { appErrorResourceIds, type AppErrorReport } from '@foreman-code/contracts'

/**
 * One append-only JSONL file of every error the API logs and every error the web app reports,
 * read with `scripts/app-errors.mjs`. Size-capped: at MAX_BYTES it moves to `<file>.1` and starts over.
 */
const MAX_BYTES = 10 * 1024 * 1024
// Identical errors inside this window become one line with a `suppressed` count, so a loop cannot flood the file.
const REPEAT_WINDOW_MS = 10_000

export type AppErrorEntry = AppErrorReport & { source: 'web' | 'api'; component?: string
  workspaceId?: string; workflowId?: string; runId?: string }

let log: { file: string; buildId: string; bytes: number } | undefined
const repeats = new Map<string, { at: number; suppressed: number }>()

function topFrame(stack: string | undefined): string | undefined {
  const frame = stack?.split('\n').map(line => line.trim()).find(line => line.startsWith('at ') || /@.+:\d+/.test(line))
  // Line and column numbers move with every edit, and directories and bundle hashes with every deploy;
  // the function and file name identify the place.
  return frame?.replace(/:\d+(:\d+)?\)?$/, '').replace(/[^\s(@]*\//g, '').replace(/-[\w]{8}\.js$/, '.js')
}

export function appErrorFingerprint(entry: Pick<AppErrorEntry, 'source' | 'message' | 'stack'>): string {
  const message = entry.message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\d+/g, '#')
  return createHash('sha256').update(`${entry.source}\n${message}\n${topFrame(entry.stack) ?? ''}`).digest('hex').slice(0, 16)
}

export function recordAppError(entry: AppErrorEntry): void {
  if (!log) return
  const fingerprint = appErrorFingerprint(entry)
  const now = Date.now()
  const repeat = repeats.get(fingerprint)
  if (repeat && now - repeat.at < REPEAT_WINDOW_MS) { repeat.suppressed += 1; return }
  if (!repeat && repeats.size >= 1000) repeats.delete(repeats.keys().next().value!)
  repeats.set(fingerprint, { at: now, suppressed: 0 })
  const line = `${JSON.stringify({ time: new Date(now).toISOString(), fingerprint, ...appErrorResourceIds(entry.url),
    ...entry, buildId: entry.buildId ?? log.buildId,
    ...(repeat?.suppressed ? { suppressed: repeat.suppressed } : {}) })}\n`
  try {
    if (log.bytes + Buffer.byteLength(line) > MAX_BYTES) { renameSync(log.file, `${log.file}.1`); log.bytes = 0 }
    appendFileSync(log.file, line)
    log.bytes += Buffer.byteLength(line)
  } catch (error) {
    // ignore: the error log cannot report its own failure through the logger that feeds it; stderr keeps it visible.
    process.stderr.write(`app error log write failed: ${String(error)}\n`)
  }
}

type PinoLine = { msg?: string; component?: string; reqId?: string; method?: string; path?: string; url?: string
  statusCode?: number; err?: { message?: string; stack?: string; code?: string | number }; error?: PinoLine['err']
  workspaceId?: string; workflowId?: string; runId?: string }

/** A pino stream for error and fatal lines. One 5xx request is one entry: the handler's line with its stack wins. */
export function openAppErrorLog(file: string, buildId: string): { write(line: string): void } {
  mkdirSync(dirname(file), { recursive: true })
  let bytes = 0
  try { bytes = statSync(file).size } catch {
    // ignore: a missing file starts empty.
  }
  log = { file, buildId, bytes }
  const recorded = new Set<string>()
  return {
    write(text: string) {
      let line: PinoLine
      try { line = JSON.parse(text) as PinoLine } catch {
        return // ignore: pino writes one JSON object per line; anything else is not an error record.
      }
      if (line.reqId) {
        if (line.msg === 'request completed' && recorded.has(line.reqId)) return
        if (recorded.size >= 1000) recorded.delete(recorded.values().next().value!)
        recorded.add(line.reqId)
      }
      const err = line.err ?? line.error
      const path = line.path ?? line.url?.split('?')[0]
      const completed = line.msg === 'request completed'
      recordAppError({ source: 'api', kind: line.statusCode ? 'http' : 'log',
        message: completed ? `HTTP ${line.statusCode} ${line.method} ${path}`
          : err?.message && err.message !== line.msg ? `${line.msg ?? 'error'}: ${err.message}` : line.msg ?? 'error',
        ...(err?.stack ? { stack: err.stack } : {}),
        ...(err?.code !== undefined ? { code: String(err.code) } : {}),
        ...(line.component ? { component: line.component } : {}),
        ...(path ? { url: path } : {}),
        ...(line.method ? { method: line.method } : {}),
        ...(line.statusCode ? { status: line.statusCode } : {}),
        ...(line.reqId ? { requestId: line.reqId } : {}),
        ...(line.workspaceId ? { workspaceId: line.workspaceId } : {}),
        ...(line.workflowId ? { workflowId: line.workflowId } : {}),
        ...(line.runId ? { runId: line.runId } : {}),
      })
    },
  }
}
