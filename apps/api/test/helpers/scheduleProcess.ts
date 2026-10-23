import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { WorkflowSchedule } from '@foreman-code/contracts/schedules'
import type { ScheduleChildInput, ScheduleChildMessage } from './scheduleDispatcherChild.js'
import type { ScheduleDispatchFixture } from './scheduleFixture.js'

/** Real OS-process faults, with IPC barriers and watchdogs. All subprocesses are
 * owned by this fixture and reaped in finally blocks; no application is launched. */
export function scheduleDispatcherProcess(f: ScheduleDispatchFixture, observed: WorkflowSchedule, mode: ScheduleChildInput['mode']) {
  const child = fork(fileURLToPath(new URL('./scheduleDispatcherChild.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TEST_DATABASE_URL: f.database.databaseUrl },
  })
  let stderr = '', terminalError: Error | undefined, finished = false
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const messages: ScheduleChildMessage[] = []
  const waiting = new Set<() => void>()
  const notify = () => { for (const fn of waiting) fn() }
  // Keep diagnostics bounded even when a product failure logs repeatedly.
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000) })
  child.stdout?.resume()
  child.on('message', (message: ScheduleChildMessage) => {
    messages.push(message)
    if (message.kind === 'error') terminalError = new Error(message.message ?? 'Child dispatch failed')
    notify()
  })
  child.on('error', (error) => { terminalError = error; notify() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => { finished = true; exitResult = { code, signal }; resolve(exitResult); notify() })
  })
  const input: ScheduleChildInput = { schema: f.database.schema, directory: f.database.directory,
    projectRoot: f.projectRoot, runtimeRoot: f.runtimeRoot, now: f.time.now, observed, mode }
  child.send(input, (error) => { if (error) { terminalError = error; notify() } })

  function waitFor(kind: ScheduleChildMessage['kind']): Promise<ScheduleChildMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`SCH-11 child did not reach ${kind}: ${stderr}`)), 15_000)
      const finish = (error?: Error, value?: ScheduleChildMessage) => {
        clearTimeout(timer); waiting.delete(check)
        if (error) reject(error)
        else resolve(value!)
      }
      const check = () => {
        const index = messages.findIndex((message) => message.kind === kind)
        if (index >= 0) { finish(undefined, messages.splice(index, 1)[0]); return }
        if (terminalError) finish(new Error(`${terminalError.message}\n${stderr}`))
        else if (finished) finish(new Error(`Child exited before ${kind} (${JSON.stringify(exitResult)}): ${stderr}`))
      }
      waiting.add(check); check()
    })
  }
  const release = () => new Promise<void>((resolve, reject) => {
    child.send('release', (error) => { if (error) reject(error); else resolve() })
  })
  const kill = async () => {
    if (!finished && !child.kill('SIGKILL')) throw new Error('Failed to kill the owned SCH-11 child')
    return exited
  }
  return { waitFor, release, exited, kill, async close() { if (!finished) await kill(); else await exited } }
}
