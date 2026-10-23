import { DomainError } from '../../errors.js'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import type { RemoteJobExecutionHost } from './jobExecutionHost.js'
import { REMOTE_EXECUTION_EXTENSION, WorkerConversationRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { DEVICE_APPLICATION_JSON_BYTES, type DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'

/** One kind of execution-v1 request a side serves. */
export interface ExecutionRoute {
  matches(payload: unknown): boolean
  handle(payload: unknown, context: DeviceExtensionContext): Promise<DeviceApplicationResult>
}

/**
 * What one side (Main, the Worker composition, the installed Worker or its workflow host) serves on execution-v1.
 * `admit` refuses a request this side must not serve, such as one on a stale channel or with binary bytes; the routes
 * are tried in order and `dispatch` takes every other request.
 */
export interface ExecutionSide {
  admit?(payload: unknown, context: DeviceExtensionContext): void
  routes?: readonly ExecutionRoute[]
  dispatch(payload: unknown, context: DeviceExtensionContext): Promise<DeviceApplicationResult>
}

/** The execution-v1 registration of every side. Each accepts one device application JSON frame and no binary bytes. */
export function executionExtension(side: ExecutionSide): DeviceExtensionRegistration {
  return { namespace: REMOTE_EXECUTION_EXTENSION, version: 1, role: 'duplex', maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0,
    async handle(payload, context) {
      side.admit?.(payload, context)
      for (const route of side.routes ?? []) if (route.matches(payload)) return route.handle(payload, context)
      return side.dispatch(payload, context)
    } }
}

/** The Worker's dispatch: workflow, Job and chat operations share the authenticated execution-v1 carrier. */
export function createRemoteExecutionHandler(workflows: { handle(raw: unknown): Promise<unknown> },
  jobs?: RemoteJobExecutionHost, conversations?: { handle(raw: unknown): Promise<unknown> }) {
  return (raw: unknown) => {
    const method = raw && typeof raw === 'object' && 'method' in raw ? raw.method : undefined
    if (typeof method === 'string' && method.startsWith('conversation.')) {
      const request = WorkerConversationRpcRequestSchema.parse(raw)
      if (!conversations) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The installed chat runtime is unavailable.', 409)
      return conversations.handle(request)
    }
    if (RemoteJobExecutionRpcRequestRecordSchema.safeParse(raw).success) {
      if (!jobs) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'This actual workflow host has no installed Job runtime.', 409)
      return jobs.handle(raw)
    }
    return workflows.handle(raw)
  }
}
