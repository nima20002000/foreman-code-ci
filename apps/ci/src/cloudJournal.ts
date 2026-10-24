import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DomainError, writeDurableFile } from '@foreman-code/contracts/server-kit'
import type { CloudRun } from './cloudProviders.js'

export async function readCloudRun(path: string): Promise<CloudRun> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DomainError('CI_RUN_UNKNOWN', 'This provider has no such CI run.', 404, undefined, { cause: error })
    }
    throw error
  }
  try {
    const run = JSON.parse(text) as CloudRun
    if (!run.runId || !run.mirror || !run.commit || !run.state) throw new Error('Missing CI ownership')
    return run
  } catch (error) {
    const failure = new DomainError('CI_RUN_CORRUPT', 'Cloud CI ownership is corrupt; recovery is required.', 409)
    failure.cause = error
    throw failure
  }
}

export async function saveCloudRun(path: string, run: CloudRun): Promise<CloudRun> {
  await writeDurableFile(path, JSON.stringify(run), { temporaryPath: `${path}.${randomUUID()}.pending` })
  return run
}
