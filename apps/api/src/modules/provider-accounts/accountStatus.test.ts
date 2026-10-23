import { expect, it } from 'vitest'
import {
  claudeConfigDir, codexHome, credentialFileName, parseClaudeAuthStatus, parseCodexAuthFile, parseCodexLoginStatus,
} from './accountStatus.js'

const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

it('names the credential file and home each provider uses', () => {
  expect(credentialFileName('codex')).toBe('auth.json')
  expect(credentialFileName('claude')).toBe('.credentials.json')
  expect(codexHome({ CODEX_HOME: '/codex', HOME: '/home/a' })).toBe('/codex')
  expect(codexHome({ HOME: '/home/a' })).toBe('/home/a/.codex')
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/claude', HOME: '/home/a' })).toBe('/claude')
  expect(claudeConfigDir({ HOME: '/home/a' })).toBe('/home/a/.claude')
})

it('reads Codex sign-in facts from auth.json without returning tokens', () => {
  expect(parseCodexAuthFile(JSON.stringify({ tokens: { id_token: jwt({ email: 'a@example.com' }) } })))
    .toEqual({ signedIn: true, account: 'a@example.com', details: ['ChatGPT'] })
  expect(parseCodexAuthFile(JSON.stringify({ OPENAI_API_KEY: 'sk-test' })))
    .toEqual({ signedIn: true, account: null, details: ['API key'] })
  expect(parseCodexAuthFile(JSON.stringify({ OPENAI_API_KEY: '' })))
    .toEqual({ signedIn: false, account: null, details: [] })
  expect(() => parseCodexAuthFile('not json')).toThrow()
})

it('classifies codex login status output', () => {
  expect(parseCodexLoginStatus({ code: 0, stdout: 'Logged in using ChatGPT\n' })).toBe('signed-in')
  expect(parseCodexLoginStatus({ code: 1, stdout: 'Logged in using ChatGPT\n' })).toBe('unknown')
  expect(parseCodexLoginStatus({ code: 1, stdout: ' Not logged in \n' })).toBe('signed-out')
  expect(parseCodexLoginStatus({ code: 0, stdout: 'something else' })).toBe('unknown')
})

it('classifies claude auth status output', () => {
  expect(parseClaudeAuthStatus({ code: 0, stdout: '{"loggedIn":true,"email":"a@example.com"}', stderr: '' }))
    .toEqual({ kind: 'status', loggedIn: true, fields: { loggedIn: true, email: 'a@example.com' } })
  expect(parseClaudeAuthStatus({ code: 1, stdout: '{"loggedIn":false}', stderr: '' }))
    .toMatchObject({ kind: 'status', loggedIn: false })
  expect(parseClaudeAuthStatus({ code: 1, stdout: 'Not logged in. Run /login', stderr: '' }))
    .toEqual({ kind: 'unreadable', signedOutNotice: true })
  expect(parseClaudeAuthStatus({ code: 0, stdout: 'Not logged in. Run /login' }))
    .toEqual({ kind: 'unreadable', signedOutNotice: false })
  expect(parseClaudeAuthStatus({ code: 1, stdout: 'boom', stderr: 'crash' }))
    .toEqual({ kind: 'unreadable', signedOutNotice: false })
  for (const stdout of ['null', '[]', '5', '{"loggedIn":"yes"}', '{}']) {
    expect(parseClaudeAuthStatus({ code: 0, stdout, stderr: '' })).toEqual({ kind: 'malformed' })
  }
})
