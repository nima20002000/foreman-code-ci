import { DomainError } from '../errors.js'
import type { InteractionService } from '../interactions/index.js'
import type { LangGraphWorkflowEngine } from './engine.js'

const registrations = new WeakMap<InteractionService, LangGraphWorkflowEngine>()

/** What an interaction service takes so approvals resume from this engine's checkpoint. */
export interface ApprovalCheckpointConsumers {
  engine: LangGraphWorkflowEngine
  prepare: Parameters<InteractionService['useApprovalPreparation']>[0]
  resume: Parameters<InteractionService['useAtomicApprovalResume']>[0]
}

/** The actual checkpoint and canonical resume receipt commit atomically. */
export function approvalCheckpointConsumers(engine: LangGraphWorkflowEngine): ApprovalCheckpointConsumers {
  return {
    engine,
    prepare: (interaction) => engine.prepareInteraction(interaction),
    resume: (claim) => engine.resumeInteraction(claim.interaction, claim),
  }
}

/** Records which engine the service resumes from; a service never has two. */
export function bindApprovalCheckpointEngine(interactions: InteractionService, engine: LangGraphWorkflowEngine): void {
  const existing = registrations.get(interactions)
  if (existing && existing !== engine) throw new DomainError('APPROVAL_RESUME_ALREADY_BOUND', 'Another engine owns this interaction service.', 409)
  registrations.set(interactions, engine)
}

/** For a service that already exists, as the focused integration fixtures build it; production passes the consumers to the constructor. */
export function registerApprovalCheckpointResume(interactions: InteractionService, engine: LangGraphWorkflowEngine): void {
  const existing = registrations.get(interactions)
  if (existing === engine) return
  if (existing) throw new DomainError('APPROVAL_RESUME_ALREADY_BOUND', 'Another engine owns this interaction service.', 409)
  const consumers = approvalCheckpointConsumers(engine)
  interactions.useApprovalPreparation(consumers.prepare)
  interactions.useAtomicApprovalResume(consumers.resume)
  bindApprovalCheckpointEngine(interactions, engine)
}

export function assertApprovalCheckpointRegistration(interactions: InteractionService, engine: LangGraphWorkflowEngine): void {
  if (registrations.get(interactions) !== engine) throw new DomainError(
    'APPROVAL_RESUME_COMPOSITION_REQUIRED', 'Bind the actual interaction service to this engine checkpoint consumer.', 503)
}
