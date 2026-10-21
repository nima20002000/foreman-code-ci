import { browserOwnerIsActive } from './browserLiveOwner.js'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, AgentSubjectSchema, canonicalJson, effectiveGraphqlTools,
  type AgentSubject, type AgentConfigurationVersion, type NodeBrowserSettings } from '@foreman-code/contracts'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readChatPrincipal, readConversationCredential } from '../access/conversationCredentials.js'
import { readConsultationCredentialSubject, readCoordinatorCredentialAuthority } from '../access/consultationAuthority.js'
import { requireActiveWorkerBinding } from '../access/workerLifecycle.js'
import { requireAuthorization } from '../access/policy.js'
import { PostgresAgentChatRepository } from '../conversations/agentChatRepository.js'
import { conversationFeatureContext } from '../conversations/conversationFeatureSubject.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { readWorkflowChatIdentity } from './workflowChatIdentity.js'
import { DomainError } from '../errors.js'
import type { BrowserSessionAuthority } from '../browser-runtime/service.js'
import type { BrowserSubjectAuthority, BrowserSession } from '../browser-runtime/types.js'
import type { BrowserProfileRepository } from '../browser-profiles/types.js'
import { browserAgentTools } from './browserTools.js'

export interface BrowserSubjectDetails {
  subject: AgentSubject; browser: NodeBrowserSettings; configuration: AgentConfigurationVersion
  computerId: string; workflowVersionId: string; readOnly: boolean; active: boolean
  tools: string[]
}

export class BrowserAuthority implements BrowserSubjectAuthority, BrowserSessionAuthority<ManagementPrincipal> {
  private readonly pins = new Map<string, Promise<BrowserSubjectDetails>>()
  constructor(private readonly pool: pg.Pool, private readonly mainId: () => string,
    private readonly profiles: () => BrowserProfileRepository,
    private readonly runtimeReady: (computerId: string) => Promise<boolean>) {}

  async conversation(conversationId: string) {
    const row = await new PostgresAgentChatRepository(this.pool).get(conversationId)
    if (!row) throw new DomainError('BROWSER_SUBJECT_UNAVAILABLE', 'The browser conversation is unavailable.', 404)
    const stored = (await this.pool.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1',
      [row.agent_configuration_version_id])).rows[0]
    const configuration = AgentConfigurationVersionSchema.parse(stored?.record)
    const prepared = row.active_request_id
      ? await new PostgresAgentChatRepository(this.pool).turnPreparedInput(row.id, row.active_request_id)
      : (await this.pool.query<{ prepared: { input: { conversationContext?: { workflowVersionId: string } } } }>(
        `select payload->'preparedInput' as prepared from operator_conversation_turns where conversation_id=$1
        and native_turn_id is not null order by turn_sequence desc limit 1`, [row.id])).rows[0]?.prepared
    const context = await conversationFeatureContext(this.pool, row, configuration, prepared?.input.conversationContext?.workflowVersionId)
    return { row, configuration, context }
  }

  private acceptedPins(raw: AgentSubject): Promise<BrowserSubjectDetails> {
    const subject = AgentSubjectSchema.parse(raw)
    const key = canonicalJson(subject)
    let pending = this.pins.get(key)
    if (!pending) {
      pending = this.readPins(subject).catch(error => {
        this.pins.delete(key)
        throw error
      })
      this.pins.set(key, pending)
    }
    return pending
  }

  async details(raw: AgentSubject): Promise<BrowserSubjectDetails> {
    const pins = await this.acceptedPins(raw)
    return { ...pins, active: await browserOwnerIsActive(this.pool, pins) }
  }

  private async readPins(raw: AgentSubject): Promise<BrowserSubjectDetails> {
    const subject = AgentSubjectSchema.parse(raw)
    let configuration: AgentConfigurationVersion
    let browser: NodeBrowserSettings | undefined
    let workflowVersionId: string
    let computerId = this.mainId()
    let active: boolean
    let tools: string[]
    if (subject.kind === 'conversation') {
      const { row, configuration: saved, context } = await this.conversation(subject.conversationId)
      configuration = saved
      if (canonicalJson(context.subject) !== canonicalJson(subject)) throw new DomainError('BROWSER_SUBJECT_CHANGED',
        'The conversation browser belongs to another saved configuration.', 409)
      browser = context.node.browser
      workflowVersionId = context.workflowVersionId
      active = !row.record.archived
      const source = row.record.origin.kind === 'run_execution' ? await readExecutionPlacement(this.pool, row.record.origin.executionId) : undefined
      const worker = row.worker_conversation_binding ? WorkerConversationBindingSchema.parse(row.worker_conversation_binding) : undefined
      const host = worker?.profile.target.hostRef ?? source?.hostRef ?? configuration.harnessProfileSelection?.target.hostRef
      if (host) computerId = host.kind === 'main' ? host.mainId : host.deviceId
      tools = effectiveGraphqlTools(subject.agent.productRole, configuration.graphqlTools, context.node.graphqlTools,
        false, browserAgentTools)
    } else {
      const consultation = subject.kind === 'coordinator_consultation'
        ? await readCoordinatorCredentialAuthority(this.pool, subject.binding) : undefined
      const execution = subject.kind === 'execution' ? subject.execution : {
        runId: subject.binding.runId, workflowVersionId: subject.binding.workflowVersionId,
        executionId: consultation!.execution.id, attempt: consultation!.execution.attempt,
        activationId: subject.binding.waitingActivationId,
      }
      const identity = await readWorkflowChatIdentity(this.pool, { kind: 'workflow_execution',
        agent: subject.agent, execution })
      if (canonicalJson(identity.agent) !== canonicalJson(subject.agent)) throw new DomainError('BROWSER_SUBJECT_CHANGED',
        'The browser subject does not match the saved Run Agent.', 409)
      const row = (await this.pool.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1',
        [identity.agent.configurationVersionId])).rows[0]
      configuration = AgentConfigurationVersionSchema.parse(row?.record)
      const node = identity.version.definition.nodes.find(item => item.id === subject.agent.workflowNodeId)
      if (!node || node.kind === 'job') throw new DomainError('BROWSER_SUBJECT_UNAVAILABLE', 'The saved browser node is unavailable.', 404)
      browser = node.browser
      workflowVersionId = identity.version.id
      active = consultation !== undefined || !identity.run.stopped
        && ['queued', 'running', 'waiting'].includes(identity.run.execution_state)
        && ['queued', 'starting', 'running', 'waiting'].includes(identity.execution!.state)
      const placement = await readExecutionPlacement(this.pool, execution.executionId)
      if (placement) computerId = placement.hostRef.kind === 'main' ? placement.hostRef.mainId : placement.hostRef.deviceId
      tools = effectiveGraphqlTools(subject.agent.productRole, configuration.graphqlTools, node.graphqlTools,
        Boolean(node.interval), browserAgentTools)
    }
    return { subject, configuration, browser: browser ?? { enabled: false }, computerId, workflowVersionId, active, tools,
      readOnly: configuration.harness.harness === 'opencode' || configuration.harness.sandbox === 'read-only' }
  }

  async resolve(subject: AgentSubject, host?: { readyComputerId: string }) {
    const details = await this.details(subject)
    if (host && details.computerId !== host.readyComputerId) throw new DomainError('BROWSER_COMPUTER_SCOPE',
      'This subject belongs to another execution computer.', 403)
    if (!details.active) throw new DomainError('BROWSER_SUBJECT_SETTLED', 'This browser subject has settled.', 409)
    let availability: 'ready' | 'profile_missing' | 'runtime_missing' = 'ready'
    const profileId = details.browser.profileId
    const present = profileId && await this.profiles().read(async tx => {
      const profile = await tx.profile(profileId)
      return !!profile && !profile.deleted && (await tx.replicaFacts(profileId, details.computerId)).present
    })
    if (!present) availability = 'profile_missing'
    else if (!host && !await this.runtimeReady(details.computerId)) availability = 'runtime_missing'
    return { subject: details.subject, browser: details.browser, computerId: details.computerId,
      readOnly: details.readOnly, availability }
  }
  async assertCurrent(subject: AgentSubject, computerId?: string) {
    const pins = await this.acceptedPins(subject)
    if (computerId && pins.computerId !== computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE',
      'This subject belongs to another execution computer.', 403)
    if (!pins.browser.enabled || !await browserOwnerIsActive(this.pool, pins)) {
      this.pins.delete(canonicalJson(subject))
      throw new DomainError('BROWSER_SUBJECT_SETTLED', 'This saved Agent no longer owns an enabled browser.', 409)
    }
  }
  callerId(principal: ManagementPrincipal) { return principal.id }

  async workerSubject(principal: ManagementPrincipal): Promise<AgentSubject> {
    await requireActiveWorkerBinding(this.pool, principal.id)
    const conversation = await readConversationCredential(this.pool, principal.id)
    if (conversation) return conversation.subject
    const binding = (await this.pool.query<{ purpose: string; execution_id: string }>(
      'select purpose,execution_id from worker_credential_bindings where principal_id=$1', [principal.id])).rows[0]
    if (binding?.purpose === 'consultation') return readConsultationCredentialSubject(this.pool, principal.id)
    if (!binding || binding.purpose !== 'workflow') throw new DomainError('ACCESS_DENIED', 'An active Agent subject is required.', 403)
    const row = (await this.pool.query<{ subject: unknown }>(`select subject from workflow_collaboration_preparations
      where execution_id=$1`, [binding.execution_id])).rows[0]
    return AgentSubjectSchema.parse(row?.subject)
  }

  async subject(principal: ManagementPrincipal, subject: AgentSubject, mutate: boolean) {
    const caller = await readChatPrincipal(this.pool, principal.id)
    if (caller.audience === 'operator') {
      const runId = subject.kind === 'execution' ? subject.execution.runId
        : subject.kind === 'coordinator_consultation' ? subject.binding.runId : undefined
      requireAuthorization(caller, mutate ? 'workflows:update' : 'workflows:read', { ...subject.agent, ...(runId ? { runId } : {}) })
      await this.details(subject)
      return
    }
    const actual = await this.workerSubject(caller)
    if (canonicalJson(actual) !== canonicalJson(subject)) throw new DomainError('ACCESS_DENIED', 'This browser belongs to another Agent subject.', 403)
    const details = await this.details(actual)
    if (!details.active || !details.browser.enabled || mutate && details.readOnly) throw new DomainError('ACCESS_DENIED',
      'This Agent cannot perform the requested browser operation.', 403)
  }
  async setup(principal: ManagementPrincipal, profileId: string, computerId: string, mutate: boolean) {
    requireAuthorization(await readChatPrincipal(this.pool, principal.id), mutate ? 'settings:update' : 'settings:read')
    const exists = await this.profiles().read(async tx => {
      const profile = await tx.profile(profileId)
      return !!profile && !profile.deleted && (await tx.replicaFacts(profileId, computerId)).present
    })
    if (!exists) throw new DomainError('BROWSER_PROFILE_MISSING', 'This profile has not been added to the selected computer.', 404)
  }
  async session(principal: ManagementPrincipal, session: BrowserSession, mutate: boolean) {
    if (session.subject) await this.subject(principal, session.subject, mutate)
    else await this.setup(principal, session.profileId, session.computerId, mutate)
  }
  async actor(principal: ManagementPrincipal, session: BrowserSession): Promise<'agent' | 'viewer'> {
    await this.session(principal, session, false)
    return principal.audience === 'worker' ? 'agent' : 'viewer'
  }
}
