import { expect, it } from 'vitest'
import { DomainError } from '../../modules/errors.js'
import { FileTransferError } from '../../modules/files/tools/transfers.js'
import { SourceError } from '../../modules/sources/manifest.js'
import { toolFailure } from './results.js'

it.each([
  ['SOURCE_PATH_INVALID', 'Source paths must be unambiguous relative paths.', 400],
  ['SOURCE_SENSITIVE_PATH', 'Source paths cannot name credential or sensitive files.', 400],
  ['SOURCE_CAPACITY', 'Source capacity exceeded.', 413],
  ['SOURCE_CAPTURE_TIMEOUT', 'Source capture timed out.', 503],
] as const)('preserves the public source error %s and its HTTP status', (code, message, status) => {
  const cause = new Error('private filesystem details')
  const error = new SourceError(code, message, { cause })
  expect(error).toBeInstanceOf(DomainError)
  expect(error.status).toBe(status)
  expect(error.cause).toBe(cause)
  expect(toolFailure(error)).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  })
})

it('preserves typed file transfer failures', () => {
  const code = 'FILE_WRITE_INTERRUPTED'
  const message = 'The artifact write did not complete.'
  expect(toolFailure(new FileTransferError(code, message))).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  })
})

it('keeps unrecognized errors and private causes out of public tool responses', () => {
  const error = Object.assign(new Error('private path and credentials'), { code: 'PRIVATE_ERROR', status: 400 })
  expect(toolFailure(error)).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: {
      code: 'INTERNAL_ERROR', message: 'The Operator service could not complete the request.',
    } }) }],
  })
})

it('reports a browser host error raised by its separately bundled copy with its own code and message', async () => {
  // The browser native host is bundled on its own, so its errors are instances of another copy of DomainError.
  const bundledErrors = `${import.meta.resolve('@foreman-code/contracts/server-kit')}?bundled-browser-host`
  const bundled = await import(/* @vite-ignore */ bundledErrors) as typeof import('../../modules/errors.js')
  expect(bundled.DomainError).not.toBe(DomainError)
  const error = new bundled.DomainError('BROWSER_NATIVE_TIMEOUT', 'The browser did not answer in time.', 504)
  expect(toolFailure(error)).toEqual({ isError: true, content: [{ type: 'text',
    text: JSON.stringify({ error: { code: 'BROWSER_NATIVE_TIMEOUT', message: 'The browser did not answer in time.' } }) }] })
  // Subclasses still tell their own errors apart.
  expect(new DomainError('X', 'x', 400)).not.toBeInstanceOf(SourceError)
  expect(new SourceError('SOURCE_CAPACITY', 'Source capacity exceeded.')).toBeInstanceOf(DomainError)
})
