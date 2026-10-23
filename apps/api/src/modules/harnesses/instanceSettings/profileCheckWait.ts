import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../../errors.js'
import { componentLogger } from '../../diagnostics/logger.js'

/** Automatic profile checks end within 240 seconds. Admission (a chat message, a Run start or its native session,
 * for example right after a restart) waits for an in-flight check instead of failing with
 * HARNESS_PROFILE_CHECK_PENDING. `admit` must hold no locks between attempts; `onWait` runs before the first wait. */
export async function admitWhenChecked<T>(admit: () => Promise<T>, signal: AbortSignal,
  waitMs = 250_000, onWait?: () => void): Promise<T> {
  const deadline = Date.now() + waitMs
  let waited = false
  for (;;) {
    try { return await admit() }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'HARNESS_PROFILE_CHECK_PENDING'
        || Date.now() >= deadline) throw error
      if (!waited) {
        componentLogger('harness').info({ message: error.message }, 'Waiting for the in-flight harness profile check')
        onWait?.()
      }
      waited = true
      await delay(500, undefined, { signal })
    }
  }
}
