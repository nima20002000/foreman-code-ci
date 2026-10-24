import { setTimeout as delay } from 'node:timers/promises'
import type { CiContext } from './environment.js'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { pushFullMirrorPack, type MirrorGit } from './fullMirrorPack.js'

const rejected = (error: unknown, reason: RegExp) => error instanceof DomainError && error.code === 'CI_CLOUD_FAILED'
  && reason.test(error.message)
// GitHub fails ref updates on its side when many CI parts push their refs at once; the same push succeeds shortly after.
const GITHUB_REF_FAILURE = /\[remote rejected\][^\r\n]*\((?:failed|failure)\)|fatal error in commit_refs/
const MISSING_OBJECTS = /\[remote rejected\][^\r\n]*\(missing necessary objects\)/
const ATTEMPTS = 6

export async function pushMirror(context: CiContext, git: MirrorGit, args: string[],
  target: { mirror: string; commit: string }): Promise<void> {
  let fullPack = false
  for (let attempt = 1; ; attempt++) {
    try {
      if (fullPack) await pushFullMirrorPack(git, args)
      else await git(args)
      return
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error
      if (rejected(error, MISSING_OBJECTS) && attempt === 1) {
        fullPack = true
        context.log.warn({ operation: 'retry CI mirror push', err: error, ...target, attempt },
          'CI mirror lost advertised objects; retrying once with the complete public snapshot pack')
        continue
      }
      if (!rejected(error, GITHUB_REF_FAILURE)) throw error
      context.log.warn({ operation: 'retry CI mirror push', err: error, ...target, attempt },
        'GitHub failed the CI mirror ref update; retrying the push')
      // Spread a burst of parts over a few seconds instead of retrying them together.
      await delay(Math.min(500 * 2 ** (attempt - 1), 2_000) + Math.floor(Math.random() * 1000))
    }
  }
}
