import { expect, it, vi } from 'vitest'
import { ApiError } from './apiError'
import { apiErrorFromPayload, beginFencedOperation, sendRaw } from './transport'
import { beginSessionChange, finishSessionChange } from './sessionBoundary'

it('sends without credentials and maps a lost connection to a NETWORK_ERROR', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch') })
  const error: unknown = await sendRaw('http://localhost/api/files', beginFencedOperation(), { networkMessage: 'Lost.', fetch: fetcher })
    .catch((failure: unknown) => failure)
  expect(fetcher).toHaveBeenCalledWith('http://localhost/api/files', expect.objectContaining({ credentials: 'omit' }))
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({ code: 'NETWORK_ERROR', message: 'Lost.' })
})

it('rejects a response that arrives after the document session changed', async () => {
  let answer!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => { answer = resolve }))
  const request = sendRaw('http://localhost/api/files', beginFencedOperation(), { networkMessage: 'Lost.', fetch: fetcher })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
  beginSessionChange()
  try {
    answer(new Response('{}'))
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
  } finally { finishSessionChange() }
})

it('keeps the API error body and falls back to HTTP_ERROR for anything else', () => {
  expect(apiErrorFromPayload({ error: { code: 'NOT_FOUND', message: 'Gone.' } }, 404, 'Failed.'))
    .toMatchObject({ code: 'NOT_FOUND', message: 'Gone.', status: 404 })
  expect(apiErrorFromPayload('<html>', 502, 'Failed.')).toMatchObject({ code: 'HTTP_ERROR', message: 'Failed.', status: 502 })
})
