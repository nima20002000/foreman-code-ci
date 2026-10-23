import {
  FileReferenceMutationResultSchema, FilePageSchema, FileWithRevisionSchema, MessageAttachmentRefSchema,
  PermanentFileScopeSchema, WorkflowReferenceFileScopeSchema,
  type FilePage, type FileWithRevision, type MessageAttachmentRef,
  type PermanentFileScope, type WorkflowReferenceFileScope,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import { ByteLengthError, readExactBytes, readUploadBytes, sha256Hex } from '../../shared/api/bytes'
import {
  apiErrorFromResponse, apiUrl, beginFencedOperation, installationHeaders, sendRaw, type FencedOperation,
} from '../../shared/api/transport'
import { inspectAttachment } from '../attachments/attachmentFiles'
import { referenceFilesRoot, referenceScopeKey } from './workflowFilesModel'

export interface ReferenceUpload {
  scope: WorkflowReferenceFileScope
  requestId: string
  file: File
  signal: AbortSignal
}
export interface ReferenceRemoval {
  scope: WorkflowReferenceFileScope
  ref: MessageAttachmentRef
  commandId: string
  signal: AbortSignal
}
export interface ReferenceDownload {
  scope: PermanentFileScope
  row: FileWithRevision
  signal: AbortSignal
}
export interface WorkflowFilesClient {
  list(scope: PermanentFileScope, cursor: string | undefined, signal: AbortSignal): Promise<FilePage>
  upload(input: ReferenceUpload): Promise<FileWithRevision>
  remove(input: ReferenceRemoval): Promise<FileWithRevision>
  download(input: ReferenceDownload): Promise<Blob>
}

function invalidResponse(): ApiError {
  return new ApiError({ code: 'INVALID_RESPONSE', message: 'The file response does not match the requested reference.' })
}

function parseRow(value: unknown, scope: PermanentFileScope, ref?: MessageAttachmentRef): FileWithRevision {
  const parsed = FileWithRevisionSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  const row = parsed.data
  if (row.file.scope.kind === 'temporary' || row.file.scope.kind==='job_execution' || referenceScopeKey(row.file.scope) !== referenceScopeKey(scope)
    || row.file.currentRevisionId !== row.revision.revisionId
    || (ref && (row.file.fileId !== ref.fileId || row.revision.revisionId !== ref.revisionId))) throw invalidResponse()
  return row
}

function resultRow(value: unknown, scope: PermanentFileScope, ref?: MessageAttachmentRef) {
  const parsed = FileReferenceMutationResultSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  return parseRow(parsed.data.value, scope, ref)
}

function requestContext(signal: AbortSignal): FencedOperation {
  const operation = beginFencedOperation({ signal, timeoutMs: 120_000 })
  operation.check()
  return operation
}

/** apiClient is JSON-only. Raw PUT/download go through the shared transport. */
async function rawRequest(path: string, context: FencedOperation, init: RequestInit): Promise<Response> {
  const response = await sendRaw(apiUrl(path), context, {
    ...init, headers: installationHeaders(init.headers), cache: 'no-store', redirect: 'error',
    networkMessage: 'The file request could not be completed.',
  })
  if (!response.ok) throw await apiErrorFromResponse(response, context, 'The file request failed.')
  return response
}

function pinnedPath(scope: PermanentFileScope, input: MessageAttachmentRef): string {
  const ref = MessageAttachmentRefSchema.parse(input)
  return `${referenceFilesRoot(scope)}/${encodeURIComponent(ref.fileId)}/revisions/${encodeURIComponent(ref.revisionId)}`
}

export function createWorkflowFilesHttpClient(): WorkflowFilesClient {
  return {
    async list(input, cursor, signal) {
      const scope = PermanentFileScopeSchema.parse(input)
      const query = new URLSearchParams({ limit: '25' })
      if (cursor) query.set('cursor', cursor)
      const page = await apiClient.request(`${referenceFilesRoot(scope)}?${query}`, FilePageSchema, { signal })
      for (const row of page.items) parseRow(row, scope)
      if (cursor && page.pageInfo.nextCursor === cursor) throw invalidResponse()
      return page
    },
    async upload(input) {
      // Even a cast/misbehaving caller cannot use this Board client to write the inherited group.
      const scope = WorkflowReferenceFileScopeSchema.parse(input.scope)
      const context = requestContext(input.signal)
      const inspected = inspectAttachment(input.file)
      if (!inspected.ok) throw new ApiError({ code: 'INVALID_REQUEST', message: inspected.issue.message })
      const bytes = await readUploadBytes(input.file, context.signal)
      context.check()
      const hash = await sha256Hex(bytes)
      context.check()
      const metadata = { requestId: input.requestId, filename: inspected.filename, mediaType: inspected.mediaType,
        byteSize: input.file.size, sha256: hash }
      const root = referenceFilesRoot(scope)
      const path = `${root}/uploads/${encodeURIComponent(input.requestId)}`
      function validate(value: unknown, ref?: MessageAttachmentRef) {
        const row = resultRow(value, scope, ref)
        if ((row.file.state !== 'pending' && row.file.state !== 'ready') || row.revision.origin !== 'upload'
          || row.revision.filename !== metadata.filename || row.revision.mediaType !== metadata.mediaType
          || row.revision.byteSize !== metadata.byteSize || row.revision.sha256 !== hash) throw invalidResponse()
        return row
      }
      const allocation = await apiClient.request(`${root}/uploads`, FileReferenceMutationResultSchema,
        { method: 'POST', body: metadata, signal: context.signal })
      context.check()
      const allocated = validate(allocation)
      // A lost finalize acknowledgement can replay an already-ready immutable allocation.
      if (allocated.file.state === 'ready') return allocated
      const ref = { fileId: allocated.file.fileId, revisionId: allocated.revision.revisionId }
      const response = await rawRequest(path, context, { method: 'PUT', body: bytes,
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' } })
      const payload: unknown = await response.json().catch(() => /* ignore: a body that is not JSON fails validation below */ undefined)
      context.check()
      const staged = validate(payload, ref)
      if (staged.file.state === 'ready') return staged
      const finalized = await apiClient.request(`${path}/finalize`, FileReferenceMutationResultSchema,
        { method: 'POST', body: {}, signal: context.signal })
      context.check()
      const ready = validate(finalized, ref)
      if (ready.file.state !== 'ready') throw invalidResponse()
      return ready
    },
    async remove(input) {
      const scope = WorkflowReferenceFileScopeSchema.parse(input.scope)
      const context = requestContext(input.signal)
      const result = await apiClient.request(pinnedPath(scope, input.ref), FileReferenceMutationResultSchema,
        { method: 'DELETE', body: { commandId: input.commandId }, signal: context.signal })
      context.check()
      const row = resultRow(result, scope, input.ref)
      if (row.file.state !== 'removed') throw invalidResponse()
      return row
    },
    async download(input) {
      const scope = PermanentFileScopeSchema.parse(input.scope)
      const row = parseRow(input.row, scope)
      if (row.file.state !== 'ready') throw new ApiError({ code: 'FILE_UNAVAILABLE', message: 'This file is not ready.' })
      const context = requestContext(input.signal)
      const response = await rawRequest(`${pinnedPath(scope, { fileId: row.file.fileId, revisionId: row.revision.revisionId })}/content`, context,
        { headers: { Accept: row.revision.mediaType } })
      const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
      const length = response.headers.get('Content-Length')
      if (type !== row.revision.mediaType || (length !== null && Number(length) !== row.revision.byteSize)) {
        await response.body?.cancel()
        throw invalidResponse()
      }
      if (!response.body) throw invalidResponse()
      // The shared metadata bounds allocation to 25 MiB. Do not buffer an unbounded blob().
      const bytes = await readExactBytes(response, row.revision.byteSize, context.signal).catch((error: unknown) => {
        context.check()
        throw error instanceof ByteLengthError ? invalidResponse() : error
      })
      if (await sha256Hex(bytes) !== row.revision.sha256) throw invalidResponse()
      context.check()
      return new Blob([bytes], { type: row.revision.mediaType })
    },
  }
}

/** Never navigate to, preview, or interpret downloaded content. */
export function saveReferenceDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
