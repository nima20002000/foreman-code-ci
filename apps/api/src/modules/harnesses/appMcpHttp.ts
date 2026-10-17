import { WORKER_MCP_RESPONSE_MAX_BYTES } from '@foreman-code/contracts/worker-mcp-relay'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { DomainError } from '../errors.js'

/** The API authenticates every forwarded request with its current scoped credential. */
export async function requestAppMcp(endpoint: string, body: unknown, token: string,
  protocolVersion?: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const response = await fetch(endpoint, {
    method: 'POST', body: JSON.stringify(body), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(deviceRequestTimeoutMs)]) : AbortSignal.timeout(deviceRequestTimeoutMs),
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    },
  })
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const reader = response.body?.getReader()
  try {
    while (reader) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > WORKER_MCP_RESPONSE_MAX_BYTES) {
        await reader.cancel()
        throw new DomainError('WORKER_MCP_RESPONSE_INVALID', 'The selected Main MCP response exceeds its relay limit.', 502)
      }
      chunks.push(chunk.value)
    }
  } finally { reader?.releaseLock() }
  const payload = Buffer.concat(chunks).toString('utf8')
  const type = response.headers.get('content-type')
  let contentType: 'empty' | 'application/json' | 'text/event-stream' | undefined
  if (payload === '') contentType = 'empty'
  else if (type?.startsWith('application/json')) contentType = 'application/json'
  else if (type?.startsWith('text/event-stream')) contentType = 'text/event-stream'
  if (!contentType) throw new DomainError('WORKER_MCP_RESPONSE_INVALID', 'The selected main returned an unsupported MCP response.', 502)
  return { statusCode: response.status, contentType, body: payload }
}
