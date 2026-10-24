import type { ExecutionResult, DeliveryTarget, EngineChatReadback } from '@foreman-code/contracts'
import { errorMessage } from '@foreman-code/contracts-node/server-kit'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { DomainError } from '../errors.js'
import { NativeDeliveryError } from '../harnesses/errors.js'
import type { DeliveryQualification } from '../workflow-chat/index.js'
import type { ConversationDeliveryOwner } from './conversationDeliveryOwner.js'

/*
 * Mechanics shared by the Agent and Operator chat engines. Both engines own their native managers and turn models;
 * what they have in common lives here, and the places where they deliberately differ are explicit parameters.
 */

interface StreamEvent { id: number; conversationId: string; type: string; data: Record<string, unknown> }
interface StreamEventSchema<E extends StreamEvent> { parse(value: unknown): E }

/** Live conversation events. Owners see every event; subscribers see only their conversation. */
export class ConversationEvents<E extends StreamEvent> {
  private sequence = 0
  private readonly listeners = new Map<string, Set<(event: E) => void>>()
  private readonly owners = new Set<(event: E) => void>()
  constructor(private readonly schema: StreamEventSchema<E>) {}

  publish(conversationId: string, type: E['type'], data: Record<string, unknown>) {
    const event = this.schema.parse({ id: this.sequence++, conversationId, type, data })
    for (const owner of this.owners) owner(event)
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try { listener(event) } catch (error) { logIgnoredError('engine', 'publish conversation event', error) }
    }
  }
  subscribeOwner(listener: (event: E) => void) { this.owners.add(listener); return () => this.owners.delete(listener) }
  subscribe(id: string, listener: (event: E) => void) {
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(listener); this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      // A repeated unsubscribe must not remove a later subscriber's set.
      if (!listeners.size && this.listeners.get(id) === listeners) this.listeners.delete(id)
    }
  }
}

/**
 * Serializes native lifecycle decisions per conversation. `admit` runs before each queued operation starts; the Agent
 * engine refuses new work there once it is closing, while the Operator engine still lets shutdown release runtimes.
 */
export class ConversationControlQueue {
  private readonly queued = new Map<string, Promise<unknown>>()
  constructor(private readonly admit: () => void = () => {}) {}

  run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queued.get(id) ?? Promise.resolve()
    const next = previous.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ })
      .then(() => { this.admit(); return operation() })
    this.queued.set(id, next)
    void next.finally(() => { if (this.queued.get(id) === next) this.queued.delete(id) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return next
  }
  has(id: string): boolean { return this.queued.has(id) }
  get size(): number { return this.queued.size }
  pending(): Promise<unknown>[] { return [...this.queued.values()] }
}

/**
 * Whether an error proves the native prompt was never accepted. Codex RPC errors predate NativeDeliveryCertainty:
 * `turn-start` accepts only a definite `turn/start` refusal as evidence (Operator), `any-method` accepts a definite
 * refusal of any RPC (Agent, which applies it only before its first submission or offered initial input).
 */
export function definitePromptRejection(error: unknown, rpcEvidence: 'turn-start' | 'any-method'): boolean {
  if (error instanceof NativeDeliveryError) {
    return error.operation === 'turn_submission' && error.delivery === 'not_sent'
  }
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  if (rpcEvidence === 'turn-start' && !('method' in error && error.method === 'turn/start')) return false
  return 'uncertain' in error && error.uncertain === false
}

/**
 * Whether an error proves native session creation never happened. Only the native creation boundary is evidence;
 * `providerCertainty` also accepts a provider error that declares itself definite (Operator).
 */
export function definiteCreationRejection(error: unknown, providerCertainty: boolean): boolean {
  if (error instanceof NativeDeliveryError) {
    return error.operation === 'session_creation' && error.delivery === 'not_sent'
  }
  if (!providerCertainty || !error || typeof error !== 'object') return false
  return 'certainty' in error && error.certainty === 'definite'
}

/** The native error code, preferring a provider result over the thrown error's own code. */
export function nativeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const nested = 'result' in error ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
  return nested ?? ('code' in error && typeof error.code === 'string' ? error.code : undefined)
}

/** A retryable failed result for a turn, keeping the provider's code and message when it supplied them. */
export function failedTurnResult(error: unknown, code: string, message: string): ExecutionResult {
  const provider = error && typeof error === 'object' && 'result' in error ? (error as { result?: ExecutionResult }).result?.error : undefined
  return { outcome: 'failed', error: { code: nativeErrorCode(error) ?? code,
    message: provider?.message ?? errorMessage(error, message), retryable: true } }
}

/** Delivery state of a conversation row as the common delivery readback reports it. */
export function conversationDeliveryState(row: { turn_state: string; active_request_id: string | null } | undefined):
  EngineChatReadback['state'] {
  return row?.turn_state === 'starting' ? 'starting'
    : row?.turn_state === 'canceling' || row?.turn_state === 'uncertain' ? 'settling'
      : row?.active_request_id ? 'active' : 'idle'
}

/** Resolves `auto` and refuses an intent the conversation cannot take right now. */
export function qualifyDeliveryIntent(requested: DeliveryQualification['appliedIntent'] | 'auto',
  state: { canSteer: boolean; active: boolean },
  messages: { steerUnavailable: string; notActive: string }): DeliveryQualification['appliedIntent'] {
  const applied = requested === 'auto' ? state.canSteer ? 'steer' : 'next_turn' : requested
  if (applied === 'steer' && !state.canSteer) throw new DomainError('CHAT_STEER_UNAVAILABLE', messages.steerUnavailable, 409)
  if (applied === 'interrupt_and_send' && !state.active) throw new DomainError('CHAT_TURN_NOT_ACTIVE', messages.notActive, 409)
  return applied
}

/**
 * Keeps common delivery receipts in step with the conversation: every non-delta event refreshes the conversation's
 * unfinished receipts. `target` names the exact delivery target of a conversation; `afterEvent` lets an engine
 * start queued work it owns.
 */
export function followDeliveryReceipts<E extends StreamEvent>(events: ConversationEvents<E>, owner: ConversationDeliveryOwner,
  options: { target(conversationId: string): Promise<DeliveryTarget | undefined>; operation: string;
    afterEvent?(conversationId: string): void }): void {
  const sync = async (conversationId: string) => {
    const target = await options.target(conversationId)
    if (!target) return
    for (const command of await owner.receipts.unfinishedForTarget(target)) await owner.refresh(command)
  }
  events.subscribeOwner(event => {
    if (event.type === 'delta') return
    void sync(event.conversationId).catch(error => logIgnoredError('engine', options.operation, error))
    options.afterEvent?.(event.conversationId)
  })
}
