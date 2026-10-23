// The CI runtime a build computer (Main or a paired Worker) prepares and refreshes, built with the platform context, so
// the Worker can load this module without Main's server ports.
import { CiRuntimeWorker as CiRuntimeWorkerBase } from '@foreman-code/ci/ciRuntimeWorker'
import { prepareCiRuntime as ciPrepareCiRuntime } from '@foreman-code/ci/ciRuntimePrepare'
import { lastCiRuntimeRefresh as ciLastCiRuntimeRefresh, scheduleCiRuntimeRefresh as ciScheduleCiRuntimeRefresh }
  from '@foreman-code/ci/ciRuntimeRefresh'
import type { WithoutContext } from './types.js'
import { platformCiContext } from './platform.js'

export { retainedCiJobImages } from '@foreman-code/ci/ciRuntimeImages'
export { currentCiRuntimePaths, retireCiRuntimeConfigurations } from '@foreman-code/ci/ciRuntimeRefresh'

export class CiRuntimeWorker extends CiRuntimeWorkerBase {
  constructor(...args: WithoutContext<ConstructorParameters<typeof CiRuntimeWorkerBase>>) {
    super(platformCiContext, ...args)
  }
}

export function prepareCiRuntime(input: Parameters<typeof ciPrepareCiRuntime>[1]) {
  return ciPrepareCiRuntime(platformCiContext, input)
}

export function scheduleCiRuntimeRefresh(input: Parameters<typeof ciScheduleCiRuntimeRefresh>[1]) {
  return ciScheduleCiRuntimeRefresh(platformCiContext, input)
}

export function lastCiRuntimeRefresh(stateDirectory: string, workDirectory?: string) {
  return ciLastCiRuntimeRefresh(platformCiContext, stateDirectory, workDirectory)
}
