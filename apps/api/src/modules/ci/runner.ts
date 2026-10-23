// The Worker's and Main's host CI runner, built with this host's CI context.
import { HostCiRunner as CiHostRunner, systemHostCiPorts as ciSystemHostCiPorts } from '@foreman-code/ci/runner'
import type { WithoutContext } from './types.js'
import { platformCiContext } from './platform.js'

export { hostCiDirectory } from '@foreman-code/ci/runner'
export type { HostCiPorts } from '@foreman-code/ci/runner'

export class HostCiRunner extends CiHostRunner {
  constructor(...args: WithoutContext<ConstructorParameters<typeof CiHostRunner>>) { super(platformCiContext, ...args) }
}

export function systemHostCiPorts(environment?: NodeJS.ProcessEnv) {
  return ciSystemHostCiPorts(platformCiContext, environment)
}
