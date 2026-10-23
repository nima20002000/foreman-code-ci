import { withAbortSignal } from '../../infrastructure/abortSignal.js'
import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { OwnedLease } from '../leases/ownerLeases.js'

/** The credential each native manager was issued, and the renewals that replace it one at a time. */
export class NativeCredentialLedger {
  private readonly issued = new WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential>()
  private readonly renewals = new WeakMap<NativeHarnessSessionManager, Promise<void>>()
  constructor(private readonly provider: ExecutionCredentialProvider | undefined) {}

  get(manager: NativeHarnessSessionManager): IssuedWorkerCredential | undefined { return this.issued.get(manager) }
  has(manager: NativeHarnessSessionManager): boolean { return this.issued.has(manager) }
  set(manager: NativeHarnessSessionManager, credential: IssuedWorkerCredential): void { this.issued.set(manager, credential) }
  delete(manager: NativeHarnessSessionManager): void { this.issued.delete(manager) }

  /** Secret values of the manager's credential that a persisted native record must not contain. */
  secrets(manager: NativeHarnessSessionManager): string[] {
    return Object.values(this.issued.get(manager)?.environment.variables ?? {})
  }

  /** The owner lease that keeps this manager's credential renewed. */
  lease(manager: NativeHarnessSessionManager, renew: () => Promise<void>): OwnedLease {
    return { name: 'execution credential', renewWithinMs: WORKER_CREDENTIAL_RENEWAL_WINDOW_MS,
      remainingMs: () => remainingCredentialLifetime(this.issued.get(manager)), renew }
  }

  /** Renews the manager's credential when it is close to expiry (or `force`), after any renewal already running. */
  renew(manager: NativeHarnessSessionManager, executionId: string,
    options: { force?: boolean; signal?: AbortSignal | undefined; check(): Promise<void> }): Promise<void> {
    const renew = async () => {
      options.signal?.throwIfAborted()
      await options.check()
      const credential = this.issued.get(manager)
      if (!credential) throw new Error('The native process lost its credential lease.')
      if (!options.force && remainingCredentialLifetime(credential) > WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) return
      if (!this.provider?.renew) throw new Error('The native credential cannot be renewed.')
      const expiresAt = await this.provider.renew(executionId, credential, options.signal)
      await options.check()
      if (this.issued.get(manager) !== credential || !Number.isFinite(Date.parse(expiresAt))
        || remainingCredentialLifetime({ ...credential, expiresAt }) <= 0) {
        throw new Error('Native credential renewal lost its owner or returned an invalid expiry.')
      }
      this.issued.set(manager, { ...credential, expiresAt })
    }
    const enqueue = () => {
      // A restart joins the heartbeat before reading and replacing the same process credential.
      const previous = this.renewals.get(manager)
      const renewal = (previous ? previous.then(renew, renew) : renew()).finally(() => {
        if (this.renewals.get(manager) === renewal) this.renewals.delete(manager)
      })
      this.renewals.set(manager, renewal)
      return renewal
    }
    return options.signal ? withAbortSignal(enqueue, options.signal) : enqueue()
  }
}
