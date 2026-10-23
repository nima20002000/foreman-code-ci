import { WorkflowJobListInputSchema, WorkflowJobPageSchema, type WorkflowJobListInput } from '@foreman-code/contracts/job-verification'
import { JobWorkflowExecutionReferenceReadSchema, type JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import type { z } from 'zod'
import { JobLogPageSchema, JobArtifactListSchema, JobArtifactSchema, type JobArtifact } from '@foreman-code/contracts/jobs'
import { JobDefinitionListSchema, JobDefinitionReadSchema, JobExecutionReadSchema } from '@foreman-code/contracts/job-verification'
import { JobQueueListInputSchema, JobQueuePageSchema } from '@foreman-code/contracts/job-admission'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import { readExactBytes, sha256Hex } from '../../shared/api/bytes'
import { apiUrl, beginFencedOperation, sendRaw } from '../../shared/api/transport'

const root = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}/jobs`
const executionPath = (workspaceId: string, id: string) => `${root(workspaceId)}/executions/${encodeURIComponent(id)}`
function mismatch(): never { throw new ApiError({ code: 'JOB_SELECTION_MISMATCH', message: 'The response belongs to another job or workspace.' }, 409) }
export const jobsClient = {
  async workflowExecution(input: JobWorkflowAdmissionReference, options?: RequestOptions) {
    const { reference } = await apiClient.request(`${root(input.workspaceId)}/workflow-executions/${encodeURIComponent(input.runId)}/${encodeURIComponent(input.nodeExecutionId)}`, JobWorkflowExecutionReferenceReadSchema, options)
    for (const key of ['workspaceId', 'workflowId', 'runId', 'workflowVersionId', 'nodeId', 'nodeExecutionId', 'occurrenceId', 'occurrenceIndex'] as const) if (reference[key] !== input[key]) mismatch()
    return reference
  },
  async definitions(workspaceId: string, options?: RequestOptions) {
    const { definitions } = await apiClient.request(`${root(workspaceId)}/definitions`, JobDefinitionListSchema, options)
    if (definitions.some(item => item.workspaceId !== workspaceId)) mismatch()
    return definitions
  },
  async definitionVersion(workspaceId:string,id:string,versionId:string,options?:RequestOptions) {
    const {definition}=await apiClient.request(`${root(workspaceId)}/definitions/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,JobDefinitionReadSchema,options)
    if(definition.workspaceId!==workspaceId||definition.id!==id||definition.versionId!==versionId)mismatch()
    return definition
  },
  async queuePage(workspaceId: string, pageInput: z.input<typeof JobQueueListInputSchema> = {},
    options?: RequestOptions): Promise<z.infer<typeof JobQueuePageSchema>> {
    const input = JobQueueListInputSchema.parse(pageInput)
    const query = new URLSearchParams({ historyLimit: String(input.historyLimit) })
    if (input.historyBeforeSequence) query.set('historyBeforeSequence', input.historyBeforeSequence)
    if (input.initiatingExecutionId) query.set('initiatingExecutionId', input.initiatingExecutionId)
    if (input.workflowId) query.set('workflowId', input.workflowId)
    const page = await apiClient.request(`${root(workspaceId)}/queue?${query}`, JobQueuePageSchema, options)
    if (page.tickets.some(ticket => ticket.workspaceId !== workspaceId
      || input.workflowId && ticket.workflow?.workflowId !== input.workflowId
        && ticket.initiatingAgent?.workflowId !== input.workflowId
      || input.initiatingExecutionId && ticket.initiatingAgent?.executionId !== input.initiatingExecutionId)) mismatch()
    return page
  },
  async workflowHistory(workspaceId: string, workflowId: string, pageInput: WorkflowJobListInput,
    options?: RequestOptions) {
    const input = WorkflowJobListInputSchema.parse(pageInput)
    const query = new URLSearchParams({ limit: String(input.limit) })
    if (input.cursor) query.set('cursor', JSON.stringify(input.cursor))
    const page = await apiClient.request(
      `${root(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/executions?${query}`,
      WorkflowJobPageSchema, options)
    if (page.workspaceId !== workspaceId || page.workflowId !== workflowId
      || page.items.some(({ execution }) => execution.workspaceId !== workspaceId
        || execution.workflow?.workflowId !== workflowId && execution.initiatingAgent?.workflowId !== workflowId)) {
      mismatch()
    }
    return page
  },
  async execution(workspaceId: string, id: string, options?: RequestOptions) {
    const { execution } = await apiClient.request(executionPath(workspaceId, id), JobExecutionReadSchema, options)
    if (execution.workspaceId !== workspaceId || execution.id !== id) mismatch()
    return execution
  },
  async logs(workspaceId: string, id: string, attemptId: string, afterSequence: number, options?: RequestOptions) {
    const page = await apiClient.request(`${executionPath(workspaceId, id)}/logs?afterSequence=${afterSequence}&limit=50`, JobLogPageSchema, options)
    if (page.chunks.length > 50 || page.chunks.some(chunk => chunk.executionId !== id || chunk.attemptId !== attemptId) || page.nextCursor < afterSequence) mismatch()
    return page
  },
  async artifacts(workspaceId: string, id: string, options?: RequestOptions) {
    const { artifacts } = await apiClient.request(`${executionPath(workspaceId, id)}/artifacts`, JobArtifactListSchema, options)
    if (artifacts.some(item => item.executionId !== id)) mismatch()
    return artifacts
  },
}

/** Save only digest-verified immutable bytes; artifact HTML is never opened in the app origin. */
export async function downloadJobArtifact(workspaceId: string, artifact: JobArtifact, signal?: AbortSignal) {
  const pin = JobArtifactSchema.parse(artifact)
  if (pin.state !== 'available' || pin.byteSize > 64 * 1024 * 1024) throw new ApiError({ code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact expired, unavailable or above the 64 MiB browser download limit.' })
  const operation = beginFencedOperation({ signal, timeoutMs: 120000 })
  const path = `${executionPath(workspaceId, pin.executionId)}/artifacts/${encodeURIComponent(pin.fileId)}/revisions/${encodeURIComponent(pin.revisionId)}/content`
  const response = await sendRaw(apiUrl(path), operation, { cache: 'no-store', redirect: 'error',
    networkMessage: 'Artifact bytes unavailable or permission lost.' })
  if (!response.ok) throw new ApiError({ code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact bytes unavailable or permission lost.' }, response.status)
  const bytes = await readExactBytes(response, pin.byteSize, operation.signal)
  operation.check()
  if (bytes.byteLength !== pin.byteSize || await sha256Hex(bytes) !== pin.sha256) throw new ApiError({ code: 'ARTIFACT_CORRUPT', message: 'Artifact bytes do not match the accepted revision digest or size.' })
  operation.check()
  return new Blob([bytes], { type: 'application/octet-stream' })
}
