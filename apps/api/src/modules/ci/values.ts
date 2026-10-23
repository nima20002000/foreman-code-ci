// CI functions and constants the rest of the API calls. The platform is installed before any of them can run.
import './platform.js'

export { CI_BUSY_TICKET, expireOverdueCiRuns } from '@foreman-code/ci/deadlines'
export { readHostCiStatus } from '@foreman-code/ci/status'
export { hostCiCapacity } from '@foreman-code/ci/capacity'
export { cloudCiId } from '@foreman-code/ci/cloudProviders'
