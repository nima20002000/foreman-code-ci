import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('prepares verifiable private Git and scheduler ownership under a group-writable host umask', async () => {
  const root = await privateFixtureDirectory('job-git-permissions-')
  const program = `
    import { mkdir } from 'node:fs/promises'
    import { join } from 'node:path'
    import { jobExecution } from './test/helpers/jobFixture.ts'
    import { prepareJobRepositoryFixture } from './test/helpers/jobRepositoryFixture.ts'
    import { verifyPrivateJobRepositoryMounts } from './src/modules/sources/repository.ts'
    import { qualifiedGit } from './src/modules/sources/capture.ts'
    process.umask(0o002)
    const root = process.argv[1]
    const runtime = join(root, 'runtime')
    await mkdir(runtime, { mode: 0o700 })
    const execution = jobExecution()
    const { gitMounts } = await prepareJobRepositoryFixture(execution, root, runtime)
    await verifyPrivateJobRepositoryMounts(execution, gitMounts)
    const source = (await qualifiedGit(gitMounts.git.directory, ['show', 'HEAD:fixture.txt'])).toString()
    console.log(JSON.stringify({ verified: true, source }))
  `
  try {
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, root], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 30_000,
    })
  expect(JSON.parse(stdout)).toEqual({ verified: true, source: 'Approved fixture source\n' })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 35_000)
