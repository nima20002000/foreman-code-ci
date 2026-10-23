import {
  FileMutationResultSchema as UploadResultSchema, FileWithRevisionSchema, TemporaryFileScopeSchema, fileStateAt,
  type FileMediaType, type FileWithRevision, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import { readUploadBytes, sha256Hex } from '../../shared/api/bytes'
import { beginFencedOperation, uploadWithProgress } from '../../shared/api/transport'
import { attachmentDraftKey, inspectAttachment } from './attachmentFiles'

export interface AttachmentProgress { phase: 'uploading' | 'finalizing'; percent: number | null }
export interface AttachmentUploadInput {
  requestId: string
  scope: TemporaryFileScope
  file: File
  filename: string
  mediaType: FileMediaType
  signal: AbortSignal
  onProgress: (progress: AttachmentProgress) => void
}
export interface AttachmentCancelInput { requestId: string; scope: TemporaryFileScope }
export interface AttachmentClient {
  /** Must resolve only after durable finalization, not merely after the bytes arrive. */
  upload(input: AttachmentUploadInput): Promise<FileWithRevision>
  /** Cancel an unsent allocation by its original request identity; never delete a sent file. */
  cancel(input: AttachmentCancelInput): Promise<void>
}

function invalidResponse(): ApiError {
  return new ApiError({ code: 'INVALID_RESPONSE', message: 'The upload response does not match this attachment.' })
}

/** Apply even to injected clients: never admit a foreign scope or silently follow a revision head. */
export function parseAttachmentUpload(input: AttachmentUploadInput, value: unknown, ready = true): FileWithRevision {
  const parsed = FileWithRevisionSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  const { file, revision } = parsed.data
  if (file.scope.kind !== 'temporary' || attachmentDraftKey(file.scope) !== attachmentDraftKey(input.scope)
    || file.currentRevisionId !== revision.revisionId || revision.filename !== input.filename
    || revision.mediaType !== input.mediaType || revision.byteSize !== input.file.size || revision.origin !== 'upload') throw invalidResponse()
  const state = fileStateAt(file, new Date().toISOString())
  if (ready ? state !== 'ready' : state !== 'pending' && state !== 'ready') throw invalidResponse()
  return parsed.data
}

function uploadRoot(scope: TemporaryFileScope): string {
  const chat = TemporaryFileScopeSchema.parse(scope).chat
  const conversation = encodeURIComponent(chat.conversationId)
  return chat.kind === 'operator' ? `/api/operator/conversations/${conversation}/files`
    : `/api/workspaces/${encodeURIComponent(chat.workspaceId)}/agent-chat/conversations/${conversation}/files`
}

/** JSON commands use apiClient; raw bytes go through the shared progress upload. */
export function createAttachmentHttpClient(): AttachmentClient {
  return {
    async upload(input) {
      const operation = beginFencedOperation({ signal: input.signal })
      const { signal } = operation
      operation.check()
      const inspected = inspectAttachment(input.file)
      if (!inspected.ok || inspected.filename !== input.filename || inspected.mediaType !== input.mediaType) {
        throw new ApiError({ code: 'INVALID_REQUEST', message: 'The selected file is not an allowed attachment.' })
      }
      const root = uploadRoot(input.scope)
      const sha256 = await sha256Hex(await readUploadBytes(input.file, signal))
      operation.check()
      const path = `${root}/uploads/${encodeURIComponent(input.requestId)}`
      const allocated = await apiClient.request(`${root}/uploads`, UploadResultSchema, {
        method: 'POST', signal,
        body: { requestId: input.requestId, filename: input.filename, mediaType: input.mediaType, byteSize: input.file.size, sha256 },
      })
      operation.check()
      const allocation = parseAttachmentUpload(input, allocated.value, false)
      if (allocation.revision.sha256 !== sha256) throw invalidResponse()
      const uploaded = await uploadBytes(path, input.file, signal, input.onProgress)
      operation.check()
      const staged = parseAttachmentUpload(input, UploadResultSchema.parse(uploaded).value, false)
      if (staged.revision.fileId !== allocation.revision.fileId || staged.revision.revisionId !== allocation.revision.revisionId
        || staged.revision.sha256 !== sha256) throw invalidResponse()
      if (staged.file.state === 'ready') return staged
      input.onProgress({ phase: 'finalizing', percent: 100 })
      const finalized = await apiClient.request(`${path}/finalize`, UploadResultSchema, { method: 'POST', signal, body: {} })
      operation.check()
      const result = parseAttachmentUpload(input, finalized.value)
      if (result.revision.fileId !== staged.revision.fileId || result.revision.revisionId !== staged.revision.revisionId) throw invalidResponse()
      return result
    },
    async cancel(input) {
      await apiClient.request(`${uploadRoot(input.scope)}/uploads/${encodeURIComponent(input.requestId)}`, UploadResultSchema, {
        method: 'DELETE', body: {},
      })
    },
  }
}

/** XHR carries raw bytes because only it reports upload progress. */
function uploadBytes(path: string, body: File, signal: AbortSignal,
  onProgress: AttachmentUploadInput['onProgress']): Promise<unknown> {
  return uploadWithProgress(path, body, {
    signal, timeoutMs: 120_000,
    onStart: () => onProgress({ phase: 'uploading', percent: null }),
    onProgress: (event) => onProgress({
      phase: 'uploading',
      percent: event.lengthComputable && event.total > 0 ? Math.min(100, Math.max(0, Math.floor(event.loaded / event.total * 100))) : null,
    }),
    messages: {
      network: 'The attachment could not be uploaded.',
      timeout: 'The attachment upload timed out. Retry to check the same upload.',
      failed: 'The attachment could not be uploaded.',
    },
  })
}
