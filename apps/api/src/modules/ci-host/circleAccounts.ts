import type { CircleAccount, CircleAccountRead } from '@foreman-code/contracts/management'
import type { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'

/** Internal contexts carry credentials through ports and HTTP, never through public readback. */
export interface CircleAccountContext extends CircleAccount {
  ports: HostCiPorts
  http: CloudHttp
  tokenConfigured(): Promise<boolean>
  invalidate(): void
}
export interface CircleAccountRegistry {
  list(): Promise<CircleAccount[]>
}
export interface CircleAccountStatusReader {
  read(account: CircleAccount): Promise<Pick<CircleAccountRead, 'tokenConfigured' | 'ready' | 'reasons' | 'orgs'>>
}
/** Called only after a committed registry change; consumers discard only this login's cached state. */
export type CircleAccountRegistryChanged = (id: string) => void | Promise<void>
