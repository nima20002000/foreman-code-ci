import { join } from 'node:path'
import { MaintenanceCommandRecordSchema, type MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import type { MaintenancePorts } from './maintenancePorts.js'

export class MaintenanceCommandStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string,
    private readonly ports: Pick<MaintenancePorts, 'readText' | 'writePrivateText'>) {}

  async read(commandId: string) {
    await this.writes
    const text = await this.ports.readText(join(this.directory, `${commandId}.json`))
    return text === null ? undefined : MaintenanceCommandRecordSchema.parse(JSON.parse(text))
  }

  async save(commandId: string, requestHash: string, task: MaintenanceTask): Promise<void> {
    const record = MaintenanceCommandRecordSchema.parse({ requestHash, task })
    const text = `${JSON.stringify(record)}\n`
    const write = this.writes.then(() => this.ports.writePrivateText(join(this.directory, `${commandId}.json`), text))
    // The failure belongs to this caller; later saves and reads must not inherit it.
    this.writes = write.catch(() => undefined)
    await write
  }

  flushed(): Promise<void> { return this.writes }
}
