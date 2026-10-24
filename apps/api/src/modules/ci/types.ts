// Type-only views of CI for the rest of the API. It loads no code, so importing it can never create a cycle.
import type { cloudCis } from '@foreman-code/ci/cloud'

export type { HostCiService } from '@foreman-code/ci/service'
export type { CiTicketClient, CiServiceClient, HttpCiClientOptions } from '@foreman-code/ci/client'
export type { CircleAccountRegistry, CircleAccountRegistryChanged, CircleAccountStatusReader } from '@foreman-code/ci/circleAccounts'
export type { CircleCreditsReader, CircleCreditUsage } from '@foreman-code/ci/circleCredits'
export type { CircleSchedulingReading, CircleStandby } from '@foreman-code/ci/circleStandby'
export type { ReadAgentFiles } from '@foreman-code/ci/agentSnapshots'
export type { CiAuthority } from '@foreman-code/ci/authority'
export type { CircleAccountsManagementService } from '@foreman-code/ci/circleAccountsManagement'
export type { CiRuntimeProvisioner } from '@foreman-code/ci/ciRuntimeProvisioner'
export type { CiEnrollment } from '@foreman-code/ci/ciEnrollment'
/** Main's cloud CI providers, one per CircleCI organization or GitHub Actions mirror. */
export type CloudCis = ReturnType<typeof cloudCis>
/** A CI constructor's or function's parameters after its leading context. */
export type WithoutContext<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never
