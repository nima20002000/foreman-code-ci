/** Byte helpers for uploads and downloads; no API/domain dependencies. Callers validate the contract's size limit first. */
export async function readUploadBytes(file: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  if (typeof file.arrayBuffer === 'function') {
    const bytes = await file.arrayBuffer()
    signal.throwIfAborted()
    return bytes
  }
  // FileReader also supports the File implementation used by the existing JSDOM tests.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const clean = () => {
      signal.removeEventListener('abort', abort)
      reader.onload = reader.onerror = reader.onabort = null
    }
    const abort = () => {
      clean()
      reader.abort()
      reject(signal.reason)
    }
    reader.onload = () => { clean(); resolve(reader.result as ArrayBuffer) }
    reader.onerror = () => { clean(); reject(reader.error) }
    reader.onabort = () => { clean(); reject(new DOMException('Upload canceled.', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try { reader.readAsArrayBuffer(file) } catch (error) { clean(); reject(error) }
  })
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A response body that is missing, shorter or longer than the size the caller pinned. */
export class ByteLengthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ByteLengthError'
  }
}

/** Read at most `limit` bytes, including when Content-Length is absent or dishonest; never buffers more. */
export async function readBoundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid file size.')
  const announced = response.headers.get('Content-Length')
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > limit)) {
    // Cancellation is best effort; some streamed responses never settle its promise.
    void response.body?.cancel().catch(() => /* ignore: the response is already rejected */ undefined)
    throw new ByteLengthError('File content exceeds its revision size.')
  }
  const output = new Uint8Array(limit)
  if (!response.body) return output.subarray(0, 0)
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => /* ignore: the read rejects with the abort */ undefined) }
  let length = 0
  let complete = false
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      if (value.byteLength > limit - length) throw new ByteLengthError('File content exceeds its revision size.')
      output.set(value, length)
      length += value.byteLength
    }
    complete = true
    return output.subarray(0, length)
  } finally {
    signal.removeEventListener('abort', abort)
    if (!complete) void reader.cancel().catch(() => /* ignore: the stream already failed or closed */ undefined)
    reader.releaseLock()
  }
}

/** Never buffer more than the pinned revision's size, including for chunked responses. */
export async function readExactBytes(response: Response, byteSize: number, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new RangeError('Invalid file size.')
  if (!response.body && byteSize !== 0) throw new ByteLengthError('File content is missing.')
  const bytes = await readBoundedBytes(response, byteSize, signal)
  if (bytes.byteLength !== byteSize) throw new ByteLengthError('File content is truncated.')
  return bytes.buffer
}
