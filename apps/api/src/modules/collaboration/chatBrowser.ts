import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { canonicalJson, type AgentSubject, type BrowserSession } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readConversationCredential } from '../access/conversationCredentials.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import type { BrowserAuthority, BrowserSubjectDetails } from './browserAuthority.js'
import type { BrowserLifecyclePort } from './ports.js'

export const CHAT_BROWSER_IDLE_MS = 10 * 60_000

interface ChatSession { sessionId: string; commandId: string; subject: AgentSubject; profileId: string; computerId: string; usedAt: number }

/** An Agent chat's own browser: opened on the chat's first browser call on its Agent's profile, closed after
 * ten idle minutes, when the chat is archived or removed, and as soon as a Run needs the same profile. */
export class ChatBrowserSessions {
  private readonly chats = new Map<string, ChatSession>()
  private readonly opening = new Map<string, { details: Promise<BrowserSubjectDetails>; result: Promise<string> }>()
  /** Run and consultation browsers this process prepared, by session ID. */
  private readonly runs = new Map<string, { profileId: string; computerId: string }>()
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly options: {
    pool: pg.Pool; authority: BrowserAuthority; lifecycle: BrowserLifecyclePort
    /** Local and retained paired-host sessions, including ones opened before this API process started. */
    sessions(): Promise<readonly BrowserSession[]>
    /** Current control facts of a local session; undefined when this computer does not hold it. */
    localControl?(sessionId: string): { browserGeneration: number; epoch: number } | undefined
    /** Control facts of a session on any computer, through the session router; used when the local broker does not hold it. */
    sessionControl?(principal: ManagementPrincipal, sessionId: string): Promise<{ browserGeneration: number; epoch: number } | undefined>
    /** The Agent chat subject of a worker credential; defaults to its stored conversation credential. */
    chatSubject?(principal: ManagementPrincipal): Promise<Extract<AgentSubject, { kind: 'conversation' }> | undefined>
    now?(): number
  }) {}

  private now() { return this.options.now?.() ?? Date.now() }

  private async subjectOf(principal: ManagementPrincipal) {
    if (principal.audience !== 'worker') return undefined
    return this.options.chatSubject ? await this.options.chatSubject(principal)
      : (await readConversationCredential(this.options.pool, principal.id))?.subject
  }

  /** Whether the caller is an Agent chat, whose browser tools then need no session ID. */
  async isChat(principal: ManagementPrincipal): Promise<boolean> {
    return !!await this.subjectOf(principal)
  }

  /** The calling chat's own browser session, opened on first use; undefined when the caller is not an Agent chat. */
  async sessionFor(principal: ManagementPrincipal): Promise<string | undefined> {
    const subject = await this.subjectOf(principal)
    if (!subject) return undefined
    const conversationId = subject.conversationId
    const pending = this.opening.get(conversationId)
    if (pending) return pending.result
    const details = this.options.authority.details(subject)
    const result = details.then(value => this.open(conversationId, subject, value)).finally(() => this.opening.delete(conversationId))
    this.opening.set(conversationId, { details, result })
    return result
  }

  private async open(conversationId: string, subject: AgentSubject, details: BrowserSubjectDetails): Promise<string> {
    let current = this.chats.get(conversationId)
    if (current && canonicalJson(current.subject) !== canonicalJson(subject)) {
      await this.close(conversationId)
      current = undefined
    }
    const profileId = details.browser.enabled ? details.browser.profileId : undefined
    if (!profileId) throw new DomainError('BROWSER_DISABLED', 'The browser is not turned on for this Agent.', 409)
    if (await this.runUses(profileId, details.computerId)) {
      if (current) await this.close(conversationId)
      throw new DomainError('BROWSER_IN_USE_BY_RUN', 'The browser is in use by a Run. Try again after the Run finishes.', 409)
    }
    const prepare = (commandId: string) => this.options.lifecycle.prepare({ subject, browser: details.browser,
      computerId: details.computerId, commandId })
    let commandId = current?.commandId ?? `chat-browser:${conversationId}:${randomUUID()}`
    let result = await prepare(commandId)
    // A closed earlier chat browser answers its own command as finished; open a new one.
    if (result.kind === 'unavailable' && !result.retryable && current) {
      commandId = `chat-browser:${conversationId}:${randomUUID()}`
      result = await prepare(commandId)
    }
    if (result.kind === 'unavailable') throw new DomainError('BROWSER_UNAVAILABLE',
      `The chat browser is unavailable: ${result.reason.replaceAll('_', ' ')}.`, result.retryable ? 503 : 409, { reason: result.reason })
    this.chats.set(conversationId, { sessionId: result.session.id, commandId, subject, profileId,
      computerId: details.computerId, usedAt: this.now() })
    return result.session.id
  }

  private async runUses(profileId: string, computerId: string): Promise<boolean> {
    if ([...this.runs.values()].some(run => run.profileId === profileId && run.computerId === computerId)) return true
    return (await this.options.sessions()).some(session => session.subject && session.subject.kind !== 'conversation'
      && session.state !== 'closed' && session.state !== 'failed' && session.profileId === profileId && session.computerId === computerId)
  }

  /** A chat Agent always acts as the agent on its own browser, so it never has to read and repeat control facts. */
  async agentActor(principal: ManagementPrincipal, sessionId: string): Promise<{ kind: 'agent'; browserGeneration: number; epoch: number } | undefined> {
    const control = this.options.localControl?.(sessionId) ?? await this.options.sessionControl?.(principal, sessionId)
    return control ? { kind: 'agent', ...control } : undefined
  }

  /** A Run browser is about to open on this profile: close every chat browser on it first. */
  async yieldToRun(profileId: string, computerId: string): Promise<void> {
    // Let launches on this profile land so they are closed below too; other profiles can open independently.
    await Promise.allSettled([...this.opening.values()].map(async opening => {
      const details = await opening.details
      if (details.browser.profileId === profileId && details.computerId === computerId) await opening.result
    }))
    await this.adopt()
    for (const [conversationId, chat] of [...this.chats]) {
      if (chat.profileId !== profileId || chat.computerId !== computerId) continue
      // The Run opens its browser either way; a chat browser that fails to close only shares the profile longer.
      await this.close(conversationId).catch(error => componentLogger('lifecycle').warn({ err: error,
        operation: 'close chat browser for a Run', conversationId }, 'chat browser did not close'))
    }
  }
  runOpened(session: BrowserSession): void {
    this.runs.set(session.id, { profileId: session.profileId, computerId: session.computerId })
  }
  runClosed(sessionId: string): void { this.runs.delete(sessionId) }

  private async close(conversationId: string): Promise<void> {
    const chat = this.chats.get(conversationId)
    if (!chat) return
    const result = await this.options.lifecycle.release({ sessionId: chat.sessionId, subject: chat.subject,
      commandId: `chat-browser-close:${chat.sessionId}`, reason: 'conversation_closed' })
    if (result.state !== 'pending' && this.chats.get(conversationId) === chat) this.chats.delete(conversationId)
  }

  /** Close idle and archived chats' browsers, including ones an earlier API process left open. */
  async sweep(): Promise<void> {
    await this.adopt()
    for (const [conversationId, chat] of [...this.chats]) {
      if (this.opening.has(conversationId)) continue
      let ended = this.now() - chat.usedAt >= CHAT_BROWSER_IDLE_MS
      if (!ended) {
        try { ended = !(await this.options.authority.details(chat.subject)).active } catch (error) {
          if (!(error instanceof DomainError) || error.status !== 404) throw error
          ended = true
        }
      }
      if (ended) await this.close(conversationId).catch(error => componentLogger('lifecycle').warn({ err: error,
        operation: 'close idle chat browser', conversationId }, 'chat browser did not close'))
    }
  }

  private async adopt(): Promise<void> {
    const known = new Set([...this.chats.values()].map(chat => chat.sessionId))
    for (const session of await this.options.sessions()) {
      const subject = session.subject
      if (subject?.kind !== 'conversation' || known.has(session.id) || session.state === 'closed' || session.state === 'failed'
        || this.chats.has(subject.conversationId)) continue
      this.chats.set(subject.conversationId, { sessionId: session.id, commandId: `chat-browser:${subject.conversationId}:${randomUUID()}`,
        subject, profileId: session.profileId, computerId: session.computerId, usedAt: this.now() })
    }
  }

  start(): void {
    this.timer ??= setInterval(() => {
      this.sweep().catch(error => componentLogger('lifecycle').warn({ err: error, operation: 'chat browser sweep' }, 'chat browser sweep failed'))
    }, 60_000)
    this.timer.unref()
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
