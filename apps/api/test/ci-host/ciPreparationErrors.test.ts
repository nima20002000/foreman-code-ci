import { expect, it, vi } from 'vitest'
import { prepareCiRuntime } from '@foreman-code/ci/ciRuntimePrepare'
import { runCiRuntimeCommand } from '@foreman-code/ci/ciRuntimeCommands'
import { mainCiContext } from '../../src/modules/ci/context.js'

vi.mock('@foreman-code/ci/ciRuntimeCommands', async original => ({
  ...await original<typeof import('@foreman-code/ci/ciRuntimeCommands')>(), runCiRuntimeCommand: vi.fn(),
}))

it.each(['EACCES', 'EIO', 'ABORT_ERR'])('does not fetch after a %s commit inspection failure', async code => {
  const failure = Object.assign(new Error('Commit inspection failed'), { code })
  const run = vi.mocked(runCiRuntimeCommand)
  run.mockReset().mockRejectedValueOnce(failure).mockRejectedValue(new Error('Unexpected fetch'))
  await expect(prepareCiRuntime(mainCiContext, { repository: '/fixture/repository', installer: '/fixture/installer',
    commit: 'a'.repeat(40), environment: {},
    review: { reviewedByPrincipalId: 'fixture-owner', decisionDigest: 'b'.repeat(64) },
  })).rejects.toBe(failure)
  expect(run).toHaveBeenCalledOnce()
})
