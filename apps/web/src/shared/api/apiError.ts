/** The web app's one error type for HTTP failures and responses that break their contract. */
export type ApiErrorPayload = {
  code: string
  message: string
  details?: Record<string, unknown>
  requestId?: string
}

/** A normalized error for both HTTP failures and invalid API responses. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>
  readonly requestId?: string
  /** The failed call, for error reports. */
  method?: string
  path?: string

  constructor(payload: ApiErrorPayload, status = 0, options?: ErrorOptions) {
    super(payload.message, options)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = status
    this.details = payload.details
    this.requestId = payload.requestId
  }

  static is(error: unknown): error is ApiError {
    return error instanceof ApiError
  }
}

export function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** The API is restarting or unreachable: no response, a gateway status without an API error body, or work the
 * API canceled while it shut down. */
export function isApiRestartError(error: unknown): boolean {
  return ApiError.is(error) && (error.code === 'NETWORK_ERROR' || error.code === 'API_RESTARTING'
    || (error.code === 'HTTP_ERROR' && isGatewayStatus(error.status)))
}
