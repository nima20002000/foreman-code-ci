// The one place the API starts child processes. Every child runs without a shell; a run has an explicit deadline and
// output limit; children inherit the API's own environment unless the caller passes a narrower one. API lint forbids
// importing node:child_process anywhere else in src (type-only imports stay allowed).
import {
  execFile, fork, spawn,
  type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams, type ExecFileException, type ForkOptions,
  type SpawnOptions, type SpawnOptionsWithoutStdio, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe,
} from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'

/** The environment the API was started with. Children inherit it unless a caller passes its own. */
export function hostEnvironment(): NodeJS.ProcessEnv {
  return process.env
}

export interface RunProcessOptions {
  /** Kills the process after this long; 0 means the caller's signal is the only deadline. */
  timeoutMs: number
  /** Largest stdout or stderr the run collects; more output kills the process. */
  maxOutputBytes: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  killSignal?: NodeJS.Signals
  windowsHide?: boolean
}
type Encoding = { encoding?: 'utf8' } | { encoding: 'buffer' }
type Output<O> = O extends { encoding: 'buffer' } ? Buffer : string

export interface ProcessResult<T extends string | Buffer = string> {
  /** Exit code, or null when the process did not exit by itself (signal, timeout, abort, output limit, spawn error). */
  code: number | null
  stdout: T
  stderr: T
  /** Why the run failed: a non-zero exit, timeout (`killed`), abort, output limit, or spawn error (`code` 'ENOENT'). */
  error?: ExecFileException
}

function execFileOptions(options: RunProcessOptions & Encoding) {
  return {
    encoding: options.encoding ?? 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, shell: false,
    ...(options.env ? { env: options.env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { signal: options.signal } : {}), ...(options.killSignal ? { killSignal: options.killSignal } : {}),
    ...(options.windowsHide ? { windowsHide: true } : {}),
  } as const
}

/** Starts a bounded process and calls back once with its collected output. Returns the child for streaming input. */
export function startProcess<O extends RunProcessOptions & Encoding>(file: string, args: readonly string[], options: O,
  done: (error: ExecFileException | null, stdout: Output<O>, stderr: Output<O>) => void): ChildProcess {
  return execFile(file, args, execFileOptions(options),
    (error, stdout, stderr) => done(error, stdout as Output<O>, stderr as Output<O>))
}

/** Runs a process to completion; a failed run rejects with its error, which carries `stdout` and `stderr`. */
export async function runProcess<O extends RunProcessOptions & Encoding>(file: string, args: readonly string[],
  options: O): Promise<{ stdout: Output<O>; stderr: Output<O> }> {
  // Promisified per call, so a test that replaces node:child_process sees each run.
  const execFileAsync = promisify(execFile) as unknown as (file: string, args: readonly string[],
    options: ReturnType<typeof execFileOptions>) => Promise<{ stdout: Output<O>; stderr: Output<O> }>
  return await execFileAsync(file, args, execFileOptions(options))
}

/** Runs a process to completion and always resolves once it ran, reporting a failed run through `code` and `error`. */
export async function runProcessSettled<O extends RunProcessOptions & Encoding>(file: string, args: readonly string[],
  options: O): Promise<ProcessResult<Output<O>>> {
  try {
    return { code: 0, ...await runProcess(file, args, options) }
  } catch (error) {
    const failure = error as ExecFileException & { stdout?: Output<O>; stderr?: Output<O> }
    // Invalid arguments throw before a process exists; only a run's own failure becomes a result.
    if (failure?.stdout === undefined || failure.stderr === undefined) throw error
    return { code: typeof failure.code === 'number' ? failure.code : null, stdout: failure.stdout, stderr: failure.stderr, error: failure }
  }
}

type Stdio = StdioNull | StdioPipe
type ChildInput<T> = T extends StdioPipe ? Writable : null
type ChildOutput<T> = T extends StdioPipe ? Readable : null

type NoShell<T> = Omit<T, 'shell'> & { shell?: false }

/** Starts a long-lived or streaming process. The caller owns its lifetime, output and deadline. */
export function spawnProcess(file: string, args: readonly string[], options?: NoShell<SpawnOptionsWithoutStdio>): ChildProcessWithoutNullStreams
export function spawnProcess<I extends Stdio, O extends Stdio, E extends Stdio>(file: string, args: readonly string[],
  options: NoShell<SpawnOptionsWithStdioTuple<I, O, E>>): ChildProcessByStdio<ChildInput<I>, ChildOutput<O>, ChildOutput<E>>
export function spawnProcess(file: string, args: readonly string[], options: NoShell<SpawnOptions>): ChildProcess
export function spawnProcess(file: string, args: readonly string[], options: NoShell<SpawnOptions> = {}): ChildProcess {
  return spawn(file, args, { ...options, shell: false })
}

/** Starts a Node module as a child with an IPC channel. */
export function forkProcess(modulePath: string, args: readonly string[], options: ForkOptions = {}): ChildProcess {
  return fork(modulePath, args, options)
}
