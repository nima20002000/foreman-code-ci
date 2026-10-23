import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RSYNC_STAGE_EXTENSION, RsyncTransferAuthorizeRequestSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DomainError } from '../errors.js'
import type { ProductionJobs } from '../jobs/production.js'
import { transferContextForBinding, type AcceptedTransferAuthority } from './carrier.js'
import type { InstalledMainRsyncProviders } from './productionComposition.js'
import { requireRsyncTransferOwner } from './rsyncTransferOwner.js'

type TransferJobs = Pick<ProductionJobs, 'transfers' | 'inputs' | 'outputs' | 'lifecycle'>
type RsyncEndpoint = Pick<DeviceEndpoint, 'captureRequest'>

function currentRsyncBinding(endpoint: RsyncEndpoint, deviceId: string): Readonly<DeviceSessionBinding> | undefined {
  return endpoint.captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding
}

/** Main's accepted rsync transfers: each transfer id resolves to the source, Job input or Job
 * output intent its owner admitted, on the exact current rsync channel. */
export function createMainTransferAuthority(input: {
  pool: pg.Pool
  endpoint(): RsyncEndpoint
  jobs(): TransferJobs | undefined
}): AcceptedTransferAuthority {
  const authority: AcceptedTransferAuthority = {
    async intent(id, binding) {
      const jobs = input.jobs()
      if (!jobs) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Original Main source and Job transfer services have not initialized.', 503)
      if (!isDeepStrictEqual(currentRsyncBinding(input.endpoint(), binding.deviceId), binding))
        throw new DomainError('RSYNC_CONNECTION_CONFLICT', 'Transfer lookup requires the actual current rsync channel.', 403)
      const operation = await requireRsyncTransferOwner(input.pool, id)
      if (operation === 'source.package.admit') return jobs.transfers.intent(id, binding)
      if (operation === 'job.inputs.bind') {
        return jobs.inputs.main.authorizedTransfer(id, transferContextForBinding(binding))
      }
      const intent = await jobs.outputs.admission.intentForTransfer(id)
      await jobs.outputs.admission.authorizeTransfer(intent, transferContextForBinding(binding))
      return intent
    },
    async authorize(intent, context) {
      const binding = currentRsyncBinding(input.endpoint(), intent.deviceId)
      if (!binding || !isDeepStrictEqual(transferContextForBinding(binding), context) || !isDeepStrictEqual(await authority.intent(intent.transferId, binding), intent))
        throw new DomainError('RSYNC_TRANSFER_DENIED', 'The original accepted transfer or authenticated generation changed.', 403)
    },
  }
  return authority
}

/** Routes each canonical rsync acknowledgement to the source, Job output or Job input owner of its transfer. */
export function routeMainRsyncAcknowledgements(installed: InstalledMainRsyncProviders, input: {
  endpoint(): RsyncEndpoint
  jobs(): TransferJobs | undefined
  /** Job input deliveries whose acknowledgement Main is coordinating. */
  inputAcknowledgements: ReadonlyMap<string, TransferIntent>
}): InstalledMainRsyncProviders {
  return { ...installed, acknowledged: async (...args: Parameters<NonNullable<InstalledMainRsyncProviders['acknowledged']>>) => {
    const [intent, context] = args
    const binding = currentRsyncBinding(input.endpoint(), intent.deviceId)
    if (!binding || !isDeepStrictEqual(transferContextForBinding(binding), context)) throw new DomainError('RSYNC_CONNECTION_CONFLICT', 'Canonical ACK requires the original actual Main capture.', 403)
    const jobs = input.jobs()
    if (intent.byteClass === 'source' && intent.direction === 'to-worker') {
      if (!jobs) throw new DomainError('SOURCE_RUNTIME_UNAVAILABLE', 'The original committed source lifecycle is unavailable.', 503)
      await jobs.lifecycle.acknowledged(intent, context)
    } else if (intent.byteClass === 'artifact' && intent.direction === 'to-main' && jobs && await jobs.outputs.ownsTransfer(intent.transferId)) {
      await jobs.outputs.admission.authorizeTransfer(intent, context)
      await jobs.outputs.lifecycle.acknowledged(intent)
    } else if (isDeepStrictEqual(input.inputAcknowledgements.get(intent.transferId), intent)) {
      if (!jobs) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The original input delivery authority is unavailable.', 503)
      await jobs.inputs.main.acknowledged(intent.transferId, binding)
    } else await installed.acknowledged(...args)
  } }
}

/** Main answers a Worker's rsync authorization requests with the accepted intent; metadata only. */
export function mainRsyncAuthorizationExtensions(extensions: readonly DeviceExtensionRegistration[],
  accepted: AcceptedTransferAuthority): DeviceExtensionRegistration[] {
  return extensions.map(extension => ({ ...extension, role: 'duplex' as const, async handle(raw: unknown, context: DeviceExtensionContext) {
    context.signal.throwIfAborted()
    if (context.bytes !== undefined) throw new DomainError('RSYNC_TRANSFER_DENIED', 'Transfer authorization accepts metadata only.', 403)
    const request = RsyncTransferAuthorizeRequestSchema.parse(raw)
    const intent = await accepted.intent(request.transferId, context.binding)
    context.signal.throwIfAborted()
    return { payload: intent }
  } }))
}
