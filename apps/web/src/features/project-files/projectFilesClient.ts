import {
  FileReferenceMutationResultSchema, FilePageSchema, FileRowSchema,
  WorkspaceProjectFilesListInputSchema, WorkspaceProjectFilesListSchema, WorkspaceReferenceFileScopeSchema,
  type FilePage, type FileRow, type FileWithRevision,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import {
  apiErrorFromResponse, apiUrl, beginFencedOperation, installationHeaders, sendRaw, type FencedOperation,
} from '../../shared/api/transport'
import { inspectAttachment } from '../attachments'
import { readExactBytes, readUploadBytes, sha256Hex } from '../../shared/api/bytes'

export interface ProjectFileUploadInput { workspaceId: string; requestId: string; file: File }
export interface ProjectFileRemoveInput { workspaceId: string; row: FileRow; commandId: string }

const invalidResponse = () => new ApiError({ code: 'INVALID_RESPONSE', message: 'The file response does not match this workspace or revision.' })

function root(workspaceId: string): string {
  WorkspaceReferenceFileScopeSchema.parse({ kind: 'workspace_reference', workspaceId })
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/reference-files`
}
function checkedRow(workspaceId: string, value: unknown): FileRow {
  const row = FileRowSchema.safeParse(value)
  if (!row.success || row.data.file.scope.kind !== 'workspace_reference'
    || row.data.file.scope.workspaceId !== workspaceId) throw invalidResponse()
  return row.data
}
function sameRevision(before: FileWithRevision, after: FileWithRevision): boolean {
  return before.file.fileId === after.file.fileId && before.file.createdAt === after.file.createdAt
    && before.revision.revisionId === after.revision.revisionId
    && before.revision.createdAt === after.revision.createdAt
    && before.revision.filename === after.revision.filename && before.revision.mediaType === after.revision.mediaType
    && before.revision.byteSize === after.revision.byteSize && before.revision.sha256 === after.revision.sha256
    && before.revision.origin === after.revision.origin
}
function pinnedPath(workspaceId: string, row: FileRow): string {
  const value = checkedRow(workspaceId, row)
  return `${root(workspaceId)}/${encodeURIComponent(value.file.fileId)}/revisions/${encodeURIComponent(value.revision.revisionId)}`
}
const boundary = (signal?: AbortSignal) => beginFencedOperation({ signal, timeoutMs: 120_000 })

/** Only the raw PUT/download bypass the JSON-only apiClient, through the shared transport. */
async function rawRequest(path: string, operation: FencedOperation, body?: ArrayBuffer): Promise<Response> {
  const response = await sendRaw(apiUrl(path), operation, {
    method: body === undefined ? 'GET' : 'PUT', body,
    headers: installationHeaders(body === undefined ? { Accept: 'application/octet-stream' }
      : { Accept: 'application/json', 'Content-Type': 'application/octet-stream' }),
    cache: 'no-store', redirect: 'error', networkMessage: 'The file request could not be completed.',
  })
  if (!response.ok) throw await apiErrorFromResponse(response, operation, 'The file request failed.')
  return response
}

export const projectFilesClient = {
  async list(workspaceId: string, cursor?: string, signal?: AbortSignal): Promise<FilePage> {
    const input = WorkspaceProjectFilesListInputSchema.parse({ workspaceId, cursor, limit: 50 })
    const params = new URLSearchParams({ limit: String(input.limit) })
    if (input.cursor) params.set('cursor', input.cursor)
    const files = await apiClient.request(`${root(workspaceId)}?${params}`, FilePageSchema, { signal })
    const result = WorkspaceProjectFilesListSchema.safeParse({ workspaceId, files })
    if (!result.success || (cursor && files.pageInfo.nextCursor === cursor)) throw invalidResponse()
    return result.data.files
  },

  async upload(input: ProjectFileUploadInput): Promise<FileWithRevision> {
    // This immutable operation context survives navigation; it never reads the selected workspace later.
    const operation = boundary()
    operation.check()
    const inspected = inspectAttachment(input.file)
    if (!inspected.ok) throw new ApiError({ code: 'INVALID_REQUEST', message: inspected.issue.message })
    const uploadRoot = root(input.workspaceId)
    const bytes = await readUploadBytes(input.file, operation.signal)
    if (bytes.byteLength !== input.file.size) throw invalidResponse()
    const sha256 = await sha256Hex(bytes)
    operation.check()
    const path = `${uploadRoot}/uploads/${encodeURIComponent(input.requestId)}`
    const check = (value: unknown, ready: boolean, previous?: FileWithRevision) => {
      const row = checkedRow(input.workspaceId, value)
      if (row.revision.filename !== inspected.filename || row.revision.mediaType !== inspected.mediaType
        || row.revision.byteSize !== bytes.byteLength || row.revision.sha256 !== sha256 || row.revision.origin !== 'upload'
        || (ready ? row.file.state !== 'ready' : row.file.state !== 'pending' && row.file.state !== 'ready')
        || (previous && !sameRevision(previous, row))) throw invalidResponse()
      return row
    }
    const allocated = await apiClient.request(`${uploadRoot}/uploads`, FileReferenceMutationResultSchema, {
      method: 'POST', signal: operation.signal,
      body: { requestId: input.requestId, filename: inspected.filename, mediaType: inspected.mediaType, byteSize: bytes.byteLength, sha256 },
    })
    operation.check()
    const allocation = check(allocated.value, false)
    // Replaying a lost finalize acknowledgement must not allocate another logical file.
    if (allocation.file.state === 'ready') return allocation
    const response = await rawRequest(path, operation, bytes)
    const uploaded: unknown = await response.json().catch(() => /* ignore: a body that is not JSON fails the schema below */ undefined)
    operation.check()
    const parsed = FileReferenceMutationResultSchema.safeParse(uploaded)
    if (!parsed.success) throw invalidResponse()
    const staged = check(parsed.data.value, false, allocation)
    if (staged.file.state === 'ready') return staged
    const finalized = await apiClient.request(`${path}/finalize`, FileReferenceMutationResultSchema, {
      method: 'POST', signal: operation.signal, body: {},
    })
    operation.check()
    return check(finalized.value, true, staged)
  },

  async remove(input: ProjectFileRemoveInput): Promise<FileWithRevision> {
    const operation = boundary()
    const result = await apiClient.request(pinnedPath(input.workspaceId, input.row), FileReferenceMutationResultSchema, {
      method: 'DELETE', body: { commandId: input.commandId }, signal: operation.signal,
    })
    operation.check()
    const removed = checkedRow(input.workspaceId, result.value)
    if (removed.file.state !== 'removed' || !sameRevision(input.row, removed)) throw invalidResponse()
    return removed
  },

  async download(workspaceId: string, row: FileRow, signal: AbortSignal): Promise<Blob> {
    const value = checkedRow(workspaceId, row)
    if (value.file.state !== 'ready') throw new ApiError({ code: 'FILE_UNAVAILABLE', message: 'This file is not ready.' })
    const operation = boundary(signal)
    const response = await rawRequest(`${pinnedPath(workspaceId, value)}/content`, operation)
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (type !== value.revision.mediaType) {
      await response.body?.cancel()
      throw invalidResponse()
    }
    const bytes = await readExactBytes(response, value.revision.byteSize, operation.signal)
    const hash = await sha256Hex(bytes)
    operation.check()
    if (hash !== value.revision.sha256) throw invalidResponse()
    // Download only. Untrusted files are never rendered, navigated to, or previewed as active content.
    return new Blob([bytes], { type: 'application/octet-stream' })
  },
}
