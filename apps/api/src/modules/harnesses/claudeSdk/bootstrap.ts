import { logIgnoredError } from '../../diagnostics/ignoredError.js'
import { logger } from '../../diagnostics/logger.js'
import { recordOperationalFailure } from '../../diagnostics/operationalFailures.js'
import { inventoryPayloadFingerprints } from '../payloadFingerprintCache.js'
import { createRequire } from 'node:module'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { AcceptedProfileAuthority } from '../instanceSettings/acceptedProfile.js'
import type { TargetEnvironment } from '../hostDiscovery.js'
import type { NativeHarnessFactories } from '../runtimeFactory.js'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { ClaudeProfileOwner } from './production.js'
import { DomainError } from '../../errors.js'
import { createClaudeCurrentPinResolver, discoverInstalledClaudeSdk, type ClaudeSdkEntrypoint } from './currentPin.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './profileRevision.js'

let muslRuntime: boolean | undefined

function usesMusl() {
  if (process.platform !== 'linux') return false
  if (muslRuntime === undefined) {
    const report = process.report.getReport()
    muslRuntime = Boolean(report && typeof report === 'object' && 'header' in report
      && !(report.header as { glibcVersionRuntime?: string }).glibcVersionRuntime)
  }
  return muslRuntime
}

/** Pinned SDK 0.3.284's own native package algorithm, inspected in its installed
 * source. Selection resolves package files only; no module execution or PATH CLI. */
async function sdkNativeExecutable(entrypoint: string): Promise<string | undefined> {
  const requireSdk = createRequire(entrypoint)
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const musl = usesMusl()
  const packages = process.platform === 'linux'
    ? (musl ? [`linux-${process.arch}-musl`, `linux-${process.arch}`] : [`linux-${process.arch}`, `linux-${process.arch}-musl`])
    : [`${process.platform}-${process.arch}`]
  for (const target of packages) {
    try { return await realpath(requireSdk.resolve(`@anthropic-ai/claude-agent-sdk-${target}/claude${suffix}`)) }
    catch (error) {
      if (!['MODULE_NOT_FOUND', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      logIgnoredError('harness', 'select Claude native package', error)
    }
  }
  return undefined
}
/** The SDK's native binary lives under a per-release dependency folder; its identity is the package path below
 * node_modules, so releases that install the same package do not record a different installation. */
export function packageRelativeLauncher(executable: string): string {
  const marker = '/node_modules/'
  const offset = executable.lastIndexOf(marker)
  return offset < 0 ? executable : executable.slice(offset + marker.length)
}
function installedSdk(): ClaudeSdkEntrypoint {
  let entrypoint: string
  try { entrypoint = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk') }
  catch { throw new DomainError('CLAUDE_INSTALLED_METADATA_UNAVAILABLE', 'The installed Claude SDK entrypoint is unavailable.', 409) }
  const marker = '/node_modules/.pnpm/'
  const offset = entrypoint.indexOf(marker)
  if (offset < 0) throw new DomainError('CLAUDE_INSTALLED_METADATA_UNAVAILABLE', 'The installed SDK resolution lock is unavailable.', 409)
  return { entrypoint, installedLockPath: join(entrypoint.slice(0, offset), 'node_modules/.pnpm/lock.yaml'), nativeResolver: sdkNativeExecutable }
}

/** Startup uses only the passive half. CLI --version is a separately owned,
 * bounded diagnostic during the actual accepted profile operation. */
export function createClaudeProductionDiscovery(input: {
  registry(): ProductionHarnessRegistry
  factories(): NativeHarnessFactories
  workingDirectory: string
}) {
  const resolvers = new Map<string, ReturnType<typeof createClaudeCurrentPinResolver>>()
  // Inventory refreshes every few seconds; each distinct failure is logged once until discovery succeeds again.
  const reported = new Set<string>()
  const discover = async (host: Extract<CanonicalMachineReference, { kind: 'main' }>, environment: TargetEnvironment,
    signal?: AbortSignal): Promise<Awaited<ReturnType<typeof discoverInstalledClaudeSdk>> | { unavailable: string }> => {
    let harnessInstallationId: string | undefined
    try {
      signal?.throwIfAborted()
      const sdk = installedSdk(), selectedExecutable = await sdkNativeExecutable(sdk.entrypoint)
      if (!selectedExecutable) throw new DomainError('CLAUDE_NATIVE_EXECUTABLE_UNAVAILABLE',
        'The installed Claude SDK has no native executable for this platform.', 409)
      harnessInstallationId = commandInputHash({ hostRef: host, driverId: 'claude',
        launcher: packageRelativeLauncher(selectedExecutable) })
      const discovered = await discoverInstalledClaudeSdk({ ...sdk, selectedExecutable }, { harnessInstallationId, environment }, signal, inventoryPayloadFingerprints)
      reported.clear()
      return discovered
    } catch (error) {
      signal?.throwIfAborted()
      const code = (error as { code?: unknown } | null)?.code
      const message = error instanceof Error ? error.message : String(error)
      const key = JSON.stringify([host, harnessInstallationId ?? null, typeof code === 'string' ? code : null, message])
      if (!reported.has(key)) {
        if (reported.size >= 64) reported.clear()
        reported.add(key)
        // The per-failure set above replaces componentLogger's per-operation 30 s throttle, which would drop a
        // different failure that follows within the window; the health view still records every failure.
        logger.child({ component: 'harness' }).warn({ operation: 'discover Claude installation', host, harnessInstallationId, code,
          err: error }, 'Claude installation discovery failed')
      }
      recordOperationalFailure('harness', 'discover Claude installation', error)
      return { unavailable: `Claude installation discovery failed: ${message}` }
    }
  }
  const currentForConfiguration = async (value: Parameters<AcceptedProfileAuthority<ClaudeProfileOwner>['current']>[1], signal?: AbortSignal) => {
    if (value.configuration.harness !== 'claude' || value.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
      'The current Claude pin must come from its actual authenticated execution host.', 409)
    const binding = input.registry().pinOverride(value)
    const selectedExecutable = binding.installation.launcher.resolvedLauncher
    if (!selectedExecutable) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The exact installed Claude launcher is unavailable.', 409)
    const sdk = { ...installedSdk(), selectedExecutable }
    const key = JSON.stringify([sdk.entrypoint, sdk.installedLockPath, selectedExecutable, binding.inventoryRevision, binding.selection,
      binding.installation.environmentGeneration, binding.installation.connectionGeneration, value.instanceRevision, value.configuration.configDirectory])
    let resolve = resolvers.get(key)
    if (!resolve) {
      if (resolvers.size >= 64) resolvers.delete(resolvers.keys().next().value!)
      resolve = createClaudeCurrentPinResolver({ sdk, ownedVersionProbe: async observed => {
        if (observed.launcher !== binding.installation.launcher.resolvedLauncher
          || observed.installationFingerprint !== binding.selection.installationFingerprint
          || observed.environmentGeneration !== binding.installation.environmentGeneration) throw new DomainError('HARNESS_INSTALLATION_CHANGED',
          'The current SDK declaration differs from the accepted installation.', 409)
        return input.factories().observeClaudeVersion(binding, input.workingDirectory, observed.signal)
      } })
      resolvers.set(key, resolve)
    }
    const observed = await resolve({ hostGeneration: binding.installation.connectionGeneration,
      harnessInstallationId: binding.selection.harnessInstallationId, environment: binding.installation.launcher.environment,
      instanceRevision: value.instanceRevision, profilePath: value.configuration.configDirectory }, signal)
    if (observed.status !== 'available') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', observed.reason, 409)
    if (observed.launcher.fingerprint !== binding.selection.installationFingerprint) throw new DomainError('HARNESS_INSTALLATION_CHANGED',
      'The installed SDK and native payload changed after profile selection.', 409)
    input.registry().installations.assertCurrent(binding)
    return { registry: binding, applicationInstallationId: value.target.hostRef.mainId, suiteRevision: CLAUDE_PROFILE_CHECK_REVISION, pin: observed.pin }
  }
  const current: AcceptedProfileAuthority<ClaudeProfileOwner>['current'] = (owner, value) => currentForConfiguration(value, owner.admissionSignal)
  return { discover, current, currentForConfiguration }
}
