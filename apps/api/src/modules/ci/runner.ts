// The Worker's and Main's host CI runner. The platform is installed first, before any runner is constructed.
import './platform.js'

export { HostCiRunner, hostCiDirectory, systemHostCiPorts } from '@foreman-code/ci/runner'
export type { HostCiPorts } from '@foreman-code/ci/runner'
