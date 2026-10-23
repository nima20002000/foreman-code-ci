// Every Git command the API runs goes through these helpers, so none of them runs repository hooks or starts an
// fsmonitor daemon, whatever the repository's own configuration says.
import type { ChildProcessWithoutNullStreams, ExecFileException } from 'node:child_process'
import { runProcess, spawnProcess, startProcess, type RunProcessOptions } from './process.js'

export const GIT_SAFETY_FLAGS: readonly string[] = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/** Git arguments with the safety flags in front. */
export function safeGitArguments(args: readonly string[]): string[] {
  return [...GIT_SAFETY_FLAGS, ...args]
}

/** System Git with no system or global configuration, no prompts and no replace objects: source capture and
 * private repositories read exactly the objects they were given. */
const isolatedGit = '/usr/bin/git'
export const ISOLATED_GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
}
const isolatedArguments = (directory: string, args: readonly string[]) =>
  ['--no-replace-objects', ...safeGitArguments(['-C', directory, ...args])]

type IsolatedGitOptions = Pick<RunProcessOptions, 'timeoutMs' | 'maxOutputBytes' | 'signal' | 'killSignal'>

/** Runs isolated Git in `directory` and returns its stdout; a failed command rejects. */
export async function runIsolatedGit(directory: string, args: readonly string[], options: IsolatedGitOptions): Promise<Buffer> {
  const { stdout } = await runProcess(isolatedGit, isolatedArguments(directory, args),
    { ...options, encoding: 'buffer', env: ISOLATED_GIT_ENVIRONMENT })
  return stdout
}

/** Starts isolated Git for streaming input; `done` receives the collected output once it exits. */
export function startIsolatedGit(directory: string, args: readonly string[], options: IsolatedGitOptions,
  done: (error: ExecFileException | null) => void) {
  return startProcess(isolatedGit, isolatedArguments(directory, args),
    { ...options, encoding: 'buffer', env: ISOLATED_GIT_ENVIRONMENT }, error => done(error))
}

/** Starts a long-lived isolated Git process with piped stdio, such as `cat-file --batch`. */
export function spawnIsolatedGit(directory: string, args: readonly string[], signal: AbortSignal): ChildProcessWithoutNullStreams {
  return spawnProcess(isolatedGit, isolatedArguments(directory, args),
    { env: ISOLATED_GIT_ENVIRONMENT, signal, stdio: ['pipe', 'pipe', 'pipe'] })
}
