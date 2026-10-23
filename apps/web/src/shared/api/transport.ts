import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import { ApiError } from './apiError'
import {
  assertSession, installationHeaders, reloadChangedInstallation, sessionGeneration, sessionIsSwitching, sessionSignal,
  SessionChangedError,
} from './sessionBoundary'

/**
 * The shared HTTP transport under every web request: the JSON ApiClient, binary uploads and downloads, and the
 * Browser adapter. Each request is fenced to the document session that started it, sends no cross-origin
 * credentials, and maps transport failures to ApiError. Global fetch/XMLHttpRequest are resolved at call time so
 * MSW intercepts the real boundary in unit tests.
 */

/** One request or multi-step operation that cannot outlive the document session that started it. */
export interface FencedOperation {
  /** Aborts on any caller signal, the timeout, or a session change. */
  readonly signal: AbortSignal
  /** Throws when the session changed or the operation was aborted. */
  check(): void
}

export function beginFencedOperation(options: { signal?: AbortSignal; timeoutMs?: number } = {}): FencedOperation {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const generation = sessionGeneration()
  const signals = [options.signal, options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)]
    .filter((signal): signal is AbortSignal => signal !== undefined)
  const signal = signals.length ? AbortSignal.any([...signals, sessionSignal()]) : sessionSignal()
  return { signal, check() { assertSession(generation); signal.throwIfAborted() } }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/** Same-origin URL for an API path; Node's fetch (Vitest) needs an absolute URL. */
export function apiUrl(path: string): string {
  const origin = typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : 'http://localhost'
  return new URL(path, origin).toString()
}

export { installationHeaders }

export interface RawRequestInit extends Omit<RequestInit, 'signal' | 'credentials'> {
  /** The message of the NETWORK_ERROR raised when no response arrives. */
  networkMessage: string
  fetch?: typeof fetch
}

/** Send one fenced request and return its response, whatever its status. */
export async function sendRaw(url: string | URL, operation: FencedOperation, init: RawRequestInit): Promise<Response> {
  const { networkMessage, fetch: fetchImpl, ...request } = init
  operation.check()
  let response: Response
  try {
    response = await (fetchImpl ?? globalThis.fetch)(url, { ...request, credentials: 'omit', signal: operation.signal })
  } catch (error) {
    operation.check()
    // AbortError is meaningful to TanStack Query and callers; it is never a retryable API failure.
    if (isAbortError(error)) throw error
    throw new ApiError({ code: 'NETWORK_ERROR', message: networkMessage,
      details: { cause: error instanceof Error ? error.message : String(error) } }, undefined, { cause: error })
  }
  operation.check()
  return response
}

/** The API's own error body, or an HTTP_ERROR with the caller's message. An INSTALLATION_CHANGED error reloads. */
export function apiErrorFromPayload(payload: unknown, status: number, fallbackMessage: string): ApiError {
  const parsed = ApiErrorResponseSchema.safeParse(payload)
  if (!parsed.success) return new ApiError({ code: 'HTTP_ERROR', message: fallbackMessage }, status)
  reloadChangedInstallation(parsed.data.error.code)
  return new ApiError(parsed.data.error, status)
}

/** Read a failed response's JSON error body inside the operation's fence. */
export async function apiErrorFromResponse(response: Response, operation: FencedOperation,
  fallbackMessage: string): Promise<ApiError> {
  const payload: unknown = await response.json()
    .catch(() => /* ignore: a body that is not JSON becomes the fallback HTTP_ERROR */ undefined)
  operation.check()
  return apiErrorFromPayload(payload, response.status, fallbackMessage)
}

export interface UploadProgress { loaded: number; total: number; lengthComputable: boolean }

export interface UploadOptions {
  signal: AbortSignal
  timeoutMs: number
  onStart(): void
  onProgress(progress: UploadProgress): void
  messages: { network: string; timeout: string; failed: string }
}

/**
 * PUT raw bytes with upload progress, which fetch cannot report. Resolves with the parsed JSON body of a 2xx
 * response; rejects with ApiError, or an AbortError when the signal or the session ends the upload.
 */
export function uploadWithProgress(path: string, body: Blob, options: UploadOptions): Promise<unknown> {
  const { signal, messages } = options
  signal.throwIfAborted()
  const generation = sessionGeneration()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null
      xhr.upload.onprogress = null
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const abort = () => {
      finish(new DOMException('Upload canceled.', 'AbortError'))
      xhr.abort()
    }
    xhr.open('PUT', apiUrl(path))
    // XHR sends same-origin cookies without enabling cross-origin credentials.
    xhr.withCredentials = false
    xhr.timeout = options.timeoutMs
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    // The API rejects browser writes that do not name this document's app installation.
    installationHeaders().forEach((value, name) => xhr.setRequestHeader(name, value))
    xhr.upload.onprogress = (event) => {
      if (!settled && !signal.aborted) options.onProgress(event)
    }
    xhr.onerror = () => finish(new ApiError({ code: 'NETWORK_ERROR', message: messages.network }))
    xhr.ontimeout = () => finish(new ApiError({ code: 'UPLOAD_TIMEOUT', message: messages.timeout }))
    xhr.onabort = () => finish(new DOMException('Upload canceled.', 'AbortError'))
    xhr.onload = () => {
      try {
        assertSession(generation)
        signal.throwIfAborted()
        let payload: unknown
        try { payload = JSON.parse(xhr.responseText) } catch { payload = undefined /* ignore: a non-JSON body fails below */ }
        if (xhr.status < 200 || xhr.status >= 300) throw apiErrorFromPayload(payload, xhr.status, messages.failed)
        finish(undefined, payload)
      } catch (error) { finish(error) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      options.onStart()
      xhr.send(body)
    } catch (error) { finish(error) }
  })
}
