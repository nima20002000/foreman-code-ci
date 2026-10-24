import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import {
  ServiceHealthSchema,
  type ServiceHealth,
  type RuntimeIdentity, type RuntimeBuildIdentity, RuntimeBuildIdentitySchema, frozenRuntimeIdentity,
} from '@foreman-code/contracts'
import type { FastifyInstance } from 'fastify'

export interface ReadinessDependencies {
  database: { ping(signal?: AbortSignal): Promise<void> }
  checkpoints: { ping(signal?: AbortSignal): Promise<void> }
}

export const DEFAULT_READINESS_TIMEOUT_MS = 2000

export interface HealthRouteServices {
  readiness: ReadinessDependencies
  readinessTimeoutMs?: number
  runtimeIdentity?: () => Promise<RuntimeIdentity>
  runtimeBuildIdentity?: () => RuntimeBuildIdentity
}

type DependencyStatus = 'ok' | 'unavailable'

function createDependencyCheck(
  check: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): () => Promise<DependencyStatus> {
  let inFlight: Promise<DependencyStatus> | undefined
  return () => {
    if (inFlight) return inFlight
    const controller = new AbortController()
    const work = Promise.resolve().then(() => check(controller.signal))
    const status = work.then<DependencyStatus, DependencyStatus>(
      () => 'ok',
      () => 'unavailable',
    )
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<DependencyStatus>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Readiness deadline exceeded'))
        resolve('unavailable')
      }, timeoutMs)
    })
    const attempt = Promise.race([status, deadline])
    inFlight = attempt
    // Keep the same unavailable result while a non-cooperative check is still
    // pending. Concurrent/repeated probes must not queue more dependency work.
    void status.then(() => {
      clearTimeout(timer)
      inFlight = undefined
    })
    return attempt
  }
}

/** Liveness, readiness and runtime identity endpoints. */
export function registerHealthRoutes(app: FastifyInstance, services: HealthRouteServices): void {
  const timeoutMs = services.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const checkDatabase = createDependencyCheck(
    (signal) => services.readiness.database.ping(signal), timeoutMs,
  )
  const checkCheckpoints = createDependencyCheck(
    (signal) => services.readiness.checkpoints.ping(signal), timeoutMs,
  )

  const runtimeIdentity = services.runtimeIdentity
  if (runtimeIdentity) {
    app.get('/health/identity', async (_request, reply) => { reply.header('cache-control', 'no-store'); return frozenRuntimeIdentity(await runtimeIdentity()) })
    app.get('/api/runtime/identity', async (_request, reply) => { reply.header('cache-control', 'no-store'); return frozenRuntimeIdentity(await runtimeIdentity()) })
  }

  const runtimeBuildIdentity = services.runtimeBuildIdentity
  if (runtimeBuildIdentity) {
    app.get('/api/runtime/build-identity/v1', async (_request, reply) => {
      reply.header('cache-control', 'no-store')
      return RuntimeBuildIdentitySchema.parse(runtimeBuildIdentity())
    })
  }

  app.get('/health/live', async () => ServiceHealthSchema.parse({ status: 'ok', service: INSTALLATION_NAMES.protocol.apiService }))

  app.get('/health/ready', async (_request, reply) => {
    const [database, checkpoints] = await Promise.all([checkDatabase(), checkCheckpoints()])
    const response: ServiceHealth = ServiceHealthSchema.parse({
      status: database === 'ok' && checkpoints === 'ok' ? 'ok' : 'unavailable',
      service: INSTALLATION_NAMES.protocol.apiService,
      checks: { database, checkpoints },
    })
    if (response.status === 'unavailable') reply.code(503)
    return response
  })
}
