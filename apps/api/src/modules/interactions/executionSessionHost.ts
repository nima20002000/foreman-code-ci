import type { WorkflowVersionCurrent } from '@foreman-code/contracts/current'
import type { RunExecutionCapacity } from './executionCapacity.js'
import type { NativeCredentialLedger } from './nativeCredentialLedger.js'
import type { ExecutionSessionLifecycle } from './executionSessionLifecycle.js'
import type { ExecutionConsultations } from './executionConsultations.js'
import type { ExecutionReviewerSessions } from './executionReviewerSessions.js'
import type { ExecutionCancellation } from './executionCancellation.js'
import type { ReviewNativeCapturePort } from './reviewNativeCapture.js'
import type { DurableInteraction, ExecutionResult, HarnessExecution, HarnessExecutionRequest, WorkflowApprovalConfiguration, NativeSessionReference, CoordinationResultContext, CoordinatorConsultationBinding } from '@foreman-code/contracts'
import type { IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { WorkflowCollaborationIntegration } from '../collaboration/index.js'
import type { WorkflowQueuedInput, WorkflowChatTarget } from '../collaboration/index.js'
import type { createWorkflowChatOwner } from './workflowChatOwner.js'
import type { ReviewerDispatcher } from './reviewer.js'
import type { DeliverableContract } from './deliverable.js'
import type { SingleWriterSessionManager } from './sessionWriter.js'
import type { PostgresRunRepository } from '../runs/index.js'
import type { RunOwnership } from '../runs/index.js'
import type { WorkflowNativeCapturePort } from './workflowNativeCapture.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { CurrentInteractionRepository as PostgresInteractionRepository } from './current/repository.js'
import type { NativeManagerResolutionContext, NativeSessionManagerResolver } from './runtimePorts.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { ClosedWorkflowSession, WorkflowClosureStore } from './workflowClosure.js'
import type { RepeatReviewerBindings } from './repeatReviewer.js'
import type { ExecutionSessionAttachment } from './executionSessionAttachment.js'
import type { ExecutionWorkflowControls } from './executionWorkflowControls.js'
import type { ExecutionWorkflowObservation } from './executionWorkflowObservation.js'

export type ApprovalExecutionObservation =
  | { state: 'waiting'; execution: HarnessExecution; interaction: DurableInteraction; interactions: DurableInteraction[] }
  | { state: 'completed'; execution: HarnessExecution; result: ExecutionResult }

export interface OwnedNativeSession {
  execution: HarnessExecution
  context: NativeManagerResolutionContext
  manager: SingleWriterSessionManager
  controller: AbortController
  generation: number
  closureGeneration?: string
  closureRegistration?: Promise<string>
  launchReserved?: boolean
  launchReservation?: Promise<void>
  failed?: boolean
  session?: NativeSessionReference
  starting?: Promise<void>
  /** Restart stopped waiting for this startup; it is still in flight. */
  startupPending?: boolean
  opening?: Promise<NativeSessionReference>
  openingFailed?: boolean
  preparing?: Promise<IssuedWorkerCredential['environment'] | undefined>
  // A canceled remote attach can leave the original Worker session running without a Main acknowledgment.
  restartAttachment?: { session: NativeSessionReference; request: HarnessExecutionRequest }
  restartRecovery?: {
    owner: RunOwnership
    session: NativeSessionReference
    generation: string
    attachmentGeneration?: string
    principalId?: string
  }
  terminalRecoveredWithoutCredential?: boolean
  outputSettlementComplete?: boolean
  cleanup?: Promise<Error[]>
  reviewFinalizer?: symbol
  reviewFinishing?: boolean
  reviewOwner?: RunOwnership
  releaseReviewOwner?: () => Promise<void>
  runOwner?: RunOwnership
  stopWaitingRenewal?: () => Promise<void>
  stopReviewerRenewal?: () => Promise<void>
  reviewerRenewal?: Promise<void>
  reviewerRecoveryPending?: boolean
  pendingApprovalRestoration?: boolean
  retainedObservationError?: unknown
  activeSessionMode?: 'regular' | 'plan'
  consultation?: {
    binding: CoordinatorConsultationBinding
    commandId: string
    target: Extract<WorkflowChatTarget, { kind: 'workflow_coordinator' }>
    task?: Promise<void>
    started?: Promise<void>
    credential?: IssuedWorkerCredential
    accessRebindAttempted?: boolean
    previous?: { context: NativeManagerResolutionContext; credential?: IssuedWorkerCredential }
  }
}

export interface ApprovalObservationInput {
  candidate: HarnessExecution
  request: HarnessExecutionRequest
  approval?: WorkflowApprovalConfiguration | undefined
  agentActiveTimeoutMs?: number | undefined
  workflowId: string
  graphThreadId: string
  owner: RunOwnership
  signal: AbortSignal
  workHandoffContract?: string | undefined
  coordinationResult?: CoordinationResultContext | undefined
  hierarchyResult?: { version: WorkflowVersionCurrent; workflowNodeId: string } | undefined
  /** Enforced deliverable contract for every workflow Agent execution. */
  deliverable?: DeliverableContract | undefined
  onStarted?: (() => void) | undefined
  queuedInput?: WorkflowQueuedInput | undefined
}

/** What the coordinator works with. Tests may compose only the native ports they exercise. */
export interface ApprovalExecutionDependencies {
  runs: PostgresRunRepository
  interactions: PostgresInteractionRepository
  budgets: PostgresApprovalBudgetRepository
  managers: NativeSessionManagerResolver
  activeTimeoutMs: number
  credentials?: ExecutionCredentialProvider | undefined
  validateContinuation?: (((executionId: string, signal?: AbortSignal) => Promise<void>) & {
    forRestart?(executionId: string): Promise<void>
  }) | undefined
  workflowClosures?: WorkflowClosureStore | undefined
  repeatReviewerBindings?: RepeatReviewerBindings | undefined
  nativeCaptures?: WorkflowNativeCapturePort | undefined
  reviewNativeCaptures?: ReviewNativeCapturePort | undefined
  recoverNativeProcesses?: ((executionId: string, signal: AbortSignal, owner: RunOwnership) => Promise<boolean>) | undefined
  reserveNativeLaunch?: ((executionId: string, manager: NativeHarnessSessionManager,
    consultation?: CoordinatorConsultationBinding) => void | Promise<void>) | undefined
  prepareManagerContext?: ((context: NativeManagerResolutionContext) => Promise<NativeManagerResolutionContext>) | undefined
  commitReviewNative?: ((executionId: string) => Promise<void>) | undefined
  collaboration?: WorkflowCollaborationIntegration | undefined
}

/** Production composes the original native capture, closure, reviewer, credential and continuation ports. */
export type CurrentApprovalExecutionDependencies = ApprovalExecutionDependencies & {
  [Port in 'credentials' | 'validateContinuation' | 'workflowClosures' | 'repeatReviewerBindings' | 'nativeCaptures'
    | 'reviewNativeCaptures']-?: NonNullable<ApprovalExecutionDependencies[Port]>
}

/** Internal session state and operations shared by the coordinator's collaborators.
 * The coordinator supplies this explicitly; its implementation stays private. */
export interface ExecutionSessionHost extends ApprovalExecutionDependencies {
  readonly credentialLedger: NativeCredentialLedger
  readonly reviewers: ReviewerDispatcher
  readonly lifecycle: ExecutionSessionLifecycle
  readonly consultations: ExecutionConsultations
  readonly reviewerSessions: ExecutionReviewerSessions
  readonly cancellation: ExecutionCancellation
  readonly rawManagers: WeakMap<NativeHarnessSessionManager, NativeHarnessSessionManager>
  readonly ownedSessions: Map<string, OwnedNativeSession>
  readonly closedExecutions: Set<string>
  readonly closedWorkflowSessions: Map<string, ClosedWorkflowSession>
  readonly stoppingRuns: Set<string>
  readonly pendingCleanupRuns: Set<string>
  readonly sharedRunOwners: Map<string, RunOwnership>
  workflowControls: ReturnType<typeof createWorkflowChatOwner> | undefined
  closing: boolean
  executionCapacity: RunExecutionCapacity['limiter']
  releaseExecutionCapacity: RunExecutionCapacity['release']
  adoptRunOwner: ExecutionSessionLifecycle['adoptRunOwner']
  retainRunOwner: ExecutionSessionLifecycle['retainRunOwner']
  assertSessionIdentity: ExecutionSessionAttachment['assertSessionIdentity']
  managerContext: ExecutionSessionAttachment['managerContext']
  resolveManager: ExecutionSessionAttachment['resolveManager']
  workflowRequest: ExecutionSessionAttachment['workflowRequest']
  prepareEnvironment: ExecutionSessionAttachment['prepareEnvironment']
  maintainWaitingWorkflowCredential: ExecutionSessionAttachment['maintainWaitingWorkflowCredential']
  detachedWorkflowSession: ExecutionSessionAttachment['detachedWorkflowSession']
  waitForRestartWriter: ExecutionSessionAttachment['waitForRestartWriter']
  restorePendingWorkflowApprovals: ExecutionSessionAttachment['restorePendingWorkflowApprovals']
  recoverExecutionControls: ExecutionWorkflowControls['recoverExecutionControls']
  recoverOutputSettlement: ExecutionWorkflowObservation['recoverOutputSettlement']
  enqueueReview: ExecutionReviewerSessions['enqueueReview']
  failIntervalCheck: ExecutionCancellation['failIntervalCheck']
  abandonAttempt: ExecutionCancellation['abandonAttempt']
  finishIdleReviewers: ExecutionReviewerSessions['finishIdleReviewers']
}
