import type { BrowserBroker } from '../browser-runtime/index.js'
import type { BrowserPrepareResult } from '../browser-runtime/index.js'

type Broker = Pick<BrowserBroker, 'prepare' | 'list' | 'read'>

/** A settled subject never gets a new browser, but its cleanup still has to
 * learn whether a session exists: a prepare reply can be lost after the host
 * opened one. Answer with that open session so release closes it, or report
 * that none exists, instead of refusing the settled subject forever. */
export async function prepareOrReconcileSettled(broker: Broker,
  input: Parameters<BrowserBroker['prepare']>[0]): Promise<BrowserPrepareResult> {
  try {
    return await broker.prepare(input)
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'BROWSER_SUBJECT_SETTLED') throw error
    const owned = broker.list(input.subject).find(session => session.state !== 'closed')
    if (!owned) return { kind: 'unavailable', reason: 'disabled', retryable: false }
    const { session, control } = broker.read(owned.id)
    return { kind: 'ready', session, control }
  }
}
