import { expect, it, vi } from 'vitest'
import { publishCommit } from './githubPublisher.js'
import type { GitWorktreePorts } from './gitWorktree.js'

it.each(['fetch', 'ls-remote', 'push'])('reports the actual git %s failure without login advice', async operation => {
  const commit = 'a'.repeat(40)
  const stderr = '  fatal: Unable to create shallow.lock: File exists\n'
  const ports: GitWorktreePorts = { cloneDirectory: () => '/unused', git: vi.fn(async args => {
    if (args[0] === operation) return { code: 128, stdout: '', stderr }
    if (args[0] === 'cat-file' && operation === 'fetch') return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }) }
  // Use an existing directory so ensureClone checks its Git identity through the public port.
  ports.cloneDirectory = () => process.cwd()
  const result = publishCommit(ports, 'fixture/project', commit, new AbortController().signal)
  await expect(result).rejects.toMatchObject({ code: 'SOURCE_GITHUB_PUSH_REQUIRED',
    message: expect.stringContaining('git ' + operation + ' failed (exit 128): ' + stderr.trim()) })
  await expect(result).rejects.toMatchObject({ message: expect.not.stringContaining('gh auth login') })
})

it.each(['fetch', 'ls-remote', 'push'])('suggests login only for an authentication failure from git %s', async operation => {
  const ports: GitWorktreePorts = { cloneDirectory: () => process.cwd(), git: async args => {
    if (args[0] === operation) return { code: 128, stdout: '', stderr: 'fatal: Authentication failed\n' }
    return { code: args[0] === 'cat-file' && operation === 'fetch' ? 1 : 0, stdout: '', stderr: '' }
  } }
  await expect(publishCommit(ports, 'fixture/project', 'a'.repeat(40), new AbortController().signal))
    .rejects.toThrow(/git .*exit 128.*Authentication failed.*gh auth login/su)
})
