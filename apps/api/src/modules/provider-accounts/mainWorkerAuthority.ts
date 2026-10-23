import { isDeepStrictEqual } from 'node:util'
import { ProviderAccountWorkerAuthorityRequestSchema } from '@foreman-code/contracts/provider-accounts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../devices/index.js'
import { DomainError } from '../errors.js'
import type { ProviderAccountsService } from './service.js'

/** Main's side of provider-accounts-v1: a paired Worker asks whether its accepted account and
 * authentication operation are still allowed, on the exact connection it is bound to. */
export function createMainProviderAccountExtension(input: {
  accounts: () => ProviderAccountsService
  currentBinding(deviceId: string): Readonly<DeviceSessionBinding> | undefined
}): DeviceExtensionRegistration {
  return { namespace: 'provider-accounts-v1', version: 1, role: 'duplex', maxJsonBytes: 65_536, maxBinaryBytes: 0,
    async handle(raw, context) {
      const request = ProviderAccountWorkerAuthorityRequestSchema.parse(raw)
      const target = request.kind === 'binding' ? request.binding.target : request.operation.binding.target
      const current = input.currentBinding(context.binding.deviceId)
      if (context.bytes !== undefined || !isDeepStrictEqual(current, context.binding)
        || target.hostRef.kind !== 'device' || target.hostRef.deviceId !== context.binding.deviceId
        || target.hostRef.mainId !== context.binding.mainId
        || target.applicationInstallationId !== context.binding.workerInstallationId
        || target.keyRevision !== context.binding.keyRevision
        || target.authorizationRevision !== context.binding.authorizationRevision) {
        throw new DomainError('ACCESS_DENIED', 'The original Worker account authority is unavailable.', 403)
      }
      let payload: { available: true } | { allowed: true }
      if (request.kind === 'binding') {
        const resolved = await input.accounts().resolve(request.binding.provider, request.binding.accountId,
          { allowDefault: false, acceptedBinding: request.binding })
        if (!resolved) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The accepted account is unavailable.', 409)
        payload = { available: true }
      } else {
        await input.accounts().assertAuthenticationEligibility(request.operation)
        payload = { allowed: true }
      }
      if (!isDeepStrictEqual(current, input.currentBinding(context.binding.deviceId))) {
        throw new DomainError('ACCESS_DENIED', 'The original Worker account channel changed.', 403)
      }
      return { payload }
    } }
}
