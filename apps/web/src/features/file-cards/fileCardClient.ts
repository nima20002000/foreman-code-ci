import { FileWithRevisionSchema, MAX_FILE_BYTES, fileStateAt, type FileWithRevision, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { ApiError } from '../../shared/api/client'
import { ByteLengthError, readBoundedBytes, sha256Hex } from '../../shared/api/bytes'
import { apiErrorFromPayload, apiUrl, beginFencedOperation, sendRaw } from '../../shared/api/transport'
import { hasRasterSignature, isRasterImage } from './fileCardPresentation'

export interface FileCardClient {
  /** Implementations must return only these pinned bytes, never a latest-revision fallback. */
  download(file: FileWithRevision, options: { signal: AbortSignal }): Promise<Blob>
}

export interface FileCardHttpPaths {
  /** Same-origin operator or agent conversation file route, with pinned ID segments. */
  download: string
}

function failure(code: string, message: string, status = 0): ApiError {
  return new ApiError({ code, message }, status)
}

export function fileDownloadPath(template: string, pin: MessageAttachmentRef): string {
  const segments = template.split('/')
  if (!/^\/api\/[A-Za-z0-9_{}%/-]+$/.test(template)
    || !/^\/api\/(?:operator\/conversations\/[^/]+|workspaces\/[^/]+\/agent-chat\/conversations\/[^/]+)\/files\/\{fileId\}\/revisions\/\{revisionId\}\/content$/.test(template)
    || segments.filter((part) => part === '{fileId}').length !== 1
    || segments.filter((part) => part === '{revisionId}').length !== 1
    || segments.some((part) => /[{}]/.test(part) && part !== '{fileId}' && part !== '{revisionId}')) {
    throw failure('INVALID_REQUEST', 'Provide an operator or agent conversation file content path.')
  }
  const encode = (value: string) => {
    // URL parsers normalize dot-only segments even when percent-encoded.
    if (!value || value === '.' || value === '..') throw failure('INVALID_REQUEST', 'Invalid file identity.')
    return encodeURIComponent(value)
  }
  return template.replace('{fileId}', encode(pin.fileId)).replace('{revisionId}', encode(pin.revisionId))
}

function assertReady(file: FileWithRevision): void {
  const state = fileStateAt(file.file, new Date().toISOString())
  if (state !== 'ready') throw failure(state === 'pending' ? 'FILE_NOT_READY' : `FILE_${state.toUpperCase()}`, 'File is not available for download.')
}

/** A bounded response reader; any body beyond the limit is an INVALID_RESPONSE. */
async function readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readBoundedBytes(response, limit, signal)
  } catch (error) {
    if (error instanceof ByteLengthError) throw failure('INVALID_RESPONSE', 'The file response exceeds its expected size.')
    throw error
  }
}

/** Binary downloads through the shared transport, never from components. */
export function createFileCardHttpClient(paths: FileCardHttpPaths): FileCardClient {
  fileDownloadPath(paths.download, { fileId: 'validate-file', revisionId: 'validate-revision' })
  const template = paths.download
  return {
    async download(input, { signal }) {
      const parsed = FileWithRevisionSchema.safeParse(input)
      if (!parsed.success) throw failure('INVALID_REQUEST', 'Invalid file metadata.')
      const file = parsed.data
      assertReady(file)
      const operation = beginFencedOperation({ signal })
      const verify = () => { operation.check(); assertReady(file) }
      verify()
      const response = await sendRaw(apiUrl(fileDownloadPath(template, file.revision)), operation, {
        method: 'GET', cache: 'no-store', redirect: 'error',
        headers: { Accept: file.revision.mediaType }, networkMessage: 'The download could not be completed.',
      }).catch((error: unknown) => { verify(); throw error })
      verify()
      if (!response.ok) {
        // Do not buffer arbitrarily large error pages or expose raw server HTML/messages.
        let payload: unknown
        try {
          const bytes = await readBytes(response, 64 * 1024, operation.signal)
          payload = JSON.parse(new TextDecoder().decode(bytes))
        } catch { payload = undefined }
        verify()
        throw apiErrorFromPayload(payload, response.status, 'The download could not be completed.')
      }
      const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (response.status !== 200 || mediaType !== file.revision.mediaType) {
        void response.body?.cancel().catch(() => /* ignore: the response is already rejected */ undefined)
        throw failure('INVALID_RESPONSE', 'The file response has an unexpected type or status.')
      }
      const bytes = await readBytes(response, Math.min(file.revision.byteSize, MAX_FILE_BYTES), operation.signal)
      verify()
      if (bytes.byteLength !== file.revision.byteSize) throw failure('INVALID_RESPONSE', 'The file response is incomplete.')
      if (isRasterImage(mediaType) && !hasRasterSignature(bytes, mediaType)) {
        throw failure('INVALID_RESPONSE', 'The image response has an invalid signature.')
      }
      // Never trust a successful response to have delivered the requested immutable revision.
      if (!globalThis.crypto?.subtle) throw failure('INVALID_RESPONSE', 'Secure download verification is unavailable.')
      const sha256 = await sha256Hex(bytes)
      verify()
      if (sha256 !== file.revision.sha256) throw failure('INVALID_RESPONSE', 'The file response does not match its revision.')
      return new Blob([bytes], { type: file.revision.mediaType })
    },
  }
}
