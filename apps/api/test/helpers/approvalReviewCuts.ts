import { vi } from 'vitest'
import type { ContinuationRuntime } from './continuationCuts.js'
import { rejectableDeferred } from './deferred.js'

type ReviewNativeArgs = Parameters<ContinuationRuntime['repository']['coordination']['appendReviewNativeEvent']>

/** Pause live source publication and leave terminal settlement to the original native history read. */
export function approvalReviewCuts(f: ContinuationRuntime) {
  const started = rejectableDeferred<ReviewNativeArgs>()
  const assistant = rejectableDeferred<ReviewNativeArgs>()
  const continueStart = rejectableDeferred()
  const continueAssistant = rejectableDeferred()
  const append = f.repository.coordination.appendReviewNativeEvent.bind(f.repository.coordination)
  let sawStart = false
  let sawAssistant = false
  const spy = vi.spyOn(f.repository.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
    const [job, event, projection] = args
    const liveReview = projection?.live && event.payload.turnId === job.providerTurnOrMessageId
    if (liveReview && event.type === 'turn.completed') return
    await append(...args)
    if (!liveReview) return
    if (!sawStart && event.type === 'turn.started') {
      sawStart = true
      started.resolve(args)
      await continueStart.promise
    } else if (!sawAssistant && event.type === 'item.completed'
      && (event.payload.item as { type?: string } | undefined)?.type === 'agentMessage') {
      sawAssistant = true
      assistant.resolve(args)
      await continueAssistant.promise
    }
  })
  return { started, assistant, continueStart, continueAssistant,
    release() {
      continueStart.resolve()
      continueAssistant.resolve()
    },
    restore() { spy.mockRestore() },
  }
}
