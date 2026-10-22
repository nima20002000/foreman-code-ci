import type { AppErrorReport } from '@foreman-code/contracts'
import { z } from 'zod'
import { ApiError, apiClient, isApiRestartError } from './client'
import { documentBuildIdentity } from './documentBuildIdentity'

// The same error is sent at most once a minute, and at most 20 errors a minute in all, so a render or poll loop
// cannot flood the API's app error log.
const REPEAT_MS = 60_000
const PER_MINUTE = 20
const sent = new Map<string, number>()
let minute = { start: 0, count: 0 }

function ignored(error: unknown): boolean {
  // Cancellations, session switches and API restarts are not faults; the app recovers from them by itself.
  if (error instanceof Error && error.name === 'AbortError') return true
  // A browser notice about layout timing, not an app fault.
  if (typeof error === 'string' && error.startsWith('ResizeObserver loop')) return true
  return isApiRestartError(error) || (ApiError.is(error) && ['APP_UPDATED', 'INSTALLATION_CHANGED'].includes(error.code))
}

/** Sends one error the user saw, or the app hit, to `POST /api/app-errors`. Never throws. */
export function reportAppError(kind: string, error: unknown, stack?: string): void {
  if (ignored(error)) return
  const message = error instanceof Error ? error.message : String(error)
  const now = Date.now()
  const key = `${kind}\n${message}`
  if (now - (sent.get(key) ?? -Infinity) < REPEAT_MS) return
  if (now - minute.start >= 60_000) minute = { start: now, count: 0 }
  if (++minute.count > PER_MINUTE) return
  sent.delete(key)
  sent.set(key, now)
  if (sent.size > 200) sent.delete(sent.keys().next().value!)
  const api = ApiError.is(error) ? error : undefined
  // An API error's own stack always points into the client; the call that failed identifies it instead.
  const trace = api?.path ? `at ${api.method ?? 'GET'} ${api.path}` : stack ?? (error instanceof Error ? error.stack : undefined)
  const report: AppErrorReport = {
    kind, message: message.slice(0, 4000), url: location.href.slice(0, 2000), buildId: documentBuildIdentity.buildId,
    ...(trace ? { stack: trace.slice(0, 16_000) } : {}),
    ...(api ? { code: api.code.slice(0, 120), ...(api.status ? { status: api.status } : {}) } : {}),
    ...(api?.method ? { method: api.method } : {}),
    ...(api?.requestId ? { requestId: api.requestId.slice(0, 120) } : {}),
  }
  void apiClient.request('/api/app-errors', z.unknown(), { method: 'POST', body: report }).catch((failure: unknown) => {
    console.warn('Could not record an app error.', failure)
  })
}

/** Errors nobody caught, and every alert or danger toast the user is shown. Called once at startup. */
export function installAppErrorReporting(): void {
  window.addEventListener('error', event => { reportAppError('window-error', event.error ?? event.message) })
  window.addEventListener('unhandledrejection', event => { reportAppError('unhandled-rejection', event.reason) })
  // Error banners and toasts are rendered in many places; watching the page catches each one where the user sees it.
  const shown = new WeakMap<Element, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    timer = undefined
    for (const element of document.querySelectorAll('[role="alert"], .n-toast[data-tone="danger"]')) {
      const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      if (!text || shown.get(element) === text) continue
      shown.set(element, text)
      reportAppError('alert', text)
    }
  }
  new MutationObserver(() => { timer ??= setTimeout(scan, 1000) })
    .observe(document.body, { childList: true, subtree: true, characterData: true })
}
