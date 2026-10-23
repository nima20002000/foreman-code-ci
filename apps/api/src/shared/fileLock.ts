import type { FileHandle } from 'node:fs/promises'
import { spawnProcess } from './process.js'

/** Node has no flock(2), so /usr/bin/flock takes the lock on the inherited open file description. The lock stays
 * after flock exits, until the last holder of that description closes it. Resolves with flock's exit code:
 * 0 when locked, 1 when a non-blocking request found the file busy. An abort kills flock and rejects. */
export function flockOpenFile(file: FileHandle, options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}): Promise<number | null> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawnProcess('/usr/bin/flock', ['--exclusive', ...(options.nonBlocking ? ['--nonblock'] : []), '3'], {
      stdio: ['ignore', 'ignore', 'ignore', file.fd], killSignal: 'SIGKILL',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    let failure: Error | undefined
    child.once('error', error => { failure = error })
    child.once('close', code => {
      if (options.signal?.aborted) reject(options.signal.reason)
      else if (failure) reject(failure)
      else resolve(code)
    })
  })
}
