import type {
  ExecutionResult,
  RunExecutionState,
  RunOutcome,
  Timestamp,
} from '@foreman-code/contracts'
import type { AcceptedWorkflowRunCurrent } from '@foreman-code/contracts/current'
import type { RepeatRepositoryServices } from './repeatRepositoryHost.js'
import type { WorkflowNativeProofServices } from './workflowNativeProof.js'

/** Current execution pins only. A3 implements storage; no missing-pin default. */
export type RepositoryExecutionSemantics = 3
export type RepositoryWorkflowRun = AcceptedWorkflowRunCurrent

/** Internal composition, not an activation flag. The central repository always
 * supplies the real canonical publisher. Native/lifecycle owners supply these
 * real same-transaction proof services; absence leaves v3 writes unavailable. */
export interface RepeatRepositoryActivation {
  runtimeRoot: string
  services: Omit<RepeatRepositoryServices, 'openPublicationLocked'>
  native: WorkflowNativeProofServices
}

export interface RunStateUpdate {
  executionState: RunExecutionState
  outcome: RunOutcome
  result?: ExecutionResult
  startedAt?: Timestamp
  finishedAt?: Timestamp
}
