import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHistory, NativeMessageSubmission } from '../harnesses/port.js'
import type { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { activityTextEnvelope } from './activityTextEnvelope.js'
import { committedNativeText } from './committedNativeText.js'
import { createNativeTextStream } from './nativeTextStream.js'

/*
 * Turn mechanics shared by the Agent and Operator chat engines. The two engines keep their own turn models (the
 * Agent settles from repository.finish, the Operator journals a terminal result and closes its runtime), so this
 * module owns only what is the same: how native output reaches the live text stream and how observed history is
 * matched to the request. Everything that differs is a hook the engine passes in.
 */

/** The engine's event stream, narrowed to the events the turn core publishes. */
export interface TurnEventSink {
  publish(type: 'delta' | 'state' | 'message', data: Record<string, unknown>): void
}

export type TurnTextRepository = Parameters<typeof committedNativeText>[0]['repository']
export type TurnTextOwner = Parameters<typeof committedNativeText>[0]['owner']
export type CommittedTurnText = ReturnType<typeof committedNativeText>
export type TurnTextOutcome = Awaited<ReturnType<CommittedTurnText['record']>>
export type TurnTextStream = ReturnType<typeof createNativeTextStream>

/** Canonical text commits, then presentation coalescing. The engine supplies its repository, owner and redactor. */
export function createTurnTextPipeline(input: {
  id: string
  requestId: string
  harness: 'codex' | 'claude'
  session: NativeSessionReference
  repository: TurnTextRepository
  owner: TurnTextOwner
  redact: ReturnType<typeof nativePersistenceRedactor>
  signal: AbortSignal
  events: TurnEventSink
  /** The engine polls native history because a commit needs readback. */
  reconcileCommit(): void
}): { committed: CommittedTurnText; textStream: TurnTextStream } {
  const { id, requestId, harness, redact } = input
  const committed = committedNativeText({ id, requestId, repository: input.repository, harness, session: input.session,
    owner: input.owner, sanitize: (operation) => redact.value(operation), reconcile: input.reconcileCommit })
  const textStream = createNativeTextStream({
    signal: input.signal, harness, owner: input.owner,
    publish: (operation) => {
      // Raw reasoning is never promoted to a public assistant answer; safe summaries use activity records.
      if (operation.identity.channel !== 'assistant') return
      const message = committed.message(operation)
      input.events.publish('delta', { requestId,
        ...(message ? { message } : {}),
        activityChange: activityTextEnvelope(redact.value(operation), harness),
        ...(committed.revision() ? { scopeRevision: committed.revision() } : {}) })
    },
    reconcile: () => input.events.publish('state', { requestId, snapshotRequired: true }),
  })
  return { committed, textStream }
}

/** What each engine does per native event; the core fixes the order in which the steps run. */
export interface TurnOutputHooks {
  /** Native output exists: later pending/history read errors are no longer prompt rejections. */
  onOutput(): void
  nativeTurnId(): string | null
  nativeSubmission(): NativeMessageSubmission | undefined
  /** Runs before the text commit (the Operator records the event's activity here). */
  beforeText?(event: NativeHarnessEvent): Promise<void>
  /** Records the event; true lets the event reach the live text stream. */
  admit(event: NativeHarnessEvent, text: TurnTextOutcome): Promise<boolean>
  /** The event asked for a native answer; the engine reads and saves the pending interaction. */
  pending(event: NativeHarnessEvent): Promise<void>
}

/** Drives one native output stream through the text pipeline and the engine's hooks. */
export async function consumeTurnOutput(output: AsyncIterable<NativeHarnessEvent>, requestId: string,
  pipeline: { committed: CommittedTurnText; textStream: TurnTextStream }, events: TurnEventSink,
  hooks: TurnOutputHooks): Promise<void> {
  const { committed, textStream } = pipeline
  for await (const event of output) {
    hooks.onOutput()
    textStream.before(event)
    await hooks.beforeText?.(event)
    const text = await committed.record(event, hooks.nativeTurnId(), hooks.nativeSubmission())
    if (await hooks.admit(event, text)) textStream.push(event)
    else textStream.rejected(event)
    if (text.final) events.publish('message', { requestId, snapshotRequired: true, scopeRevision: committed.revision() })
    if (event.type === 'interaction.pending' || event.type === 'permission.asked') await hooks.pending(event)
  }
}

/** A definitive provider rejection of this exact correlated prompt, before any native turn existed. */
export function observedNonSubmission(history: NativeHistory,
  row: { native_session_id: string | null; active_native_turn_id: string | null }, correlationId: string):
  NonNullable<NativeHistory['nonSubmission']> | undefined {
  const rejected = history.nonSubmission
  return rejected && rejected.nativeSessionId === row.native_session_id
    && rejected.clientCorrelationId === correlationId && !row.active_native_turn_id ? rejected : undefined
}

/** The Claude message receipt for this exact session and correlation, if the history carries one. */
export function observedMessageReceipt(history: NativeHistory, session: { nativeSessionId: string },
  correlationId: string): NativeMessageSubmission | undefined {
  const receipt = history.nativeSubmission
  return receipt?.kind === 'message' && receipt.nativeSessionId === session.nativeSessionId
    && receipt.clientCorrelationId === correlationId ? receipt : undefined
}
