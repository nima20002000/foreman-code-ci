import { readFile, readdir, stat } from 'node:fs/promises'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationReceiptSchema, type WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'

const ArchiveEntrySchema = z.object({ receipt: WorkerConversationReceiptSchema,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()
const ArchiveSchema = ArchiveEntrySchema.extend({ generations: z.array(ArchiveEntrySchema).optional() })

/** Closed receipts retain all replay identities outside the bounded recovery snapshot. */
export class WorkerConversationArchive {
  constructor(private readonly path: string, private readonly byteLimit: number,
    private readonly write: (path: string, value: string) => Promise<void>) {}

  private recordPath(conversationId: string) {
    return `${this.path}.conversations/${commandInputHash(conversationId)}.json`
  }

  private generationDirectory(conversationId: string) {
    return `${this.path}.conversations/${commandInputHash(conversationId)}`
  }

  private generationPath(conversationId: string, generation?: string) {
    return `${this.generationDirectory(conversationId)}/${commandInputHash(generation ?? null)}.json`
  }

  async read(conversationId: string, generation?: string): Promise<WorkerConversationReceipt | undefined> {
    const path = this.generationPath(conversationId, generation)
    const records = await this.readFile(path, conversationId)
    if (records.length) return this.generationRecord(path, conversationId, records)
    return (await this.readFile(this.recordPath(conversationId), conversationId))
      .find(record => record.binding.generation === generation)
  }

  async readAll(conversationId: string): Promise<WorkerConversationReceipt[]> {
    // Existing combined archives remain readable; subsequent saves use separate generation files.
    const records = new Map((await this.readFile(this.recordPath(conversationId), conversationId))
      .map(record => [record.binding.generation, record]))
    const directory = this.generationDirectory(conversationId)
    let names: string[]
    try { names = await readdir(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...records.values()]
      throw error
    }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const path = `${directory}/${name}`
      const record = this.generationRecord(path, conversationId, await this.readFile(path, conversationId))
      records.set(record.binding.generation, record)
    }
    return [...records.values()]
  }

  private generationRecord(path: string, conversationId: string, records: WorkerConversationReceipt[]) {
    const record = records[0]
    if (records.length !== 1 || !record || this.generationPath(conversationId, record.binding.generation) !== path) {
      throw new Error('Conversation archive changed: recovery required')
    }
    return record
  }

  private async readFile(path: string, conversationId: string): Promise<WorkerConversationReceipt[]> {
    let serialized: string
    try {
      if ((await stat(path)).size > this.byteLimit + 1024) throw new Error('Conversation archive byte limit reached')
      serialized = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const archive = ArchiveSchema.parse(JSON.parse(serialized))
    const entries = [archive, ...(archive.generations ?? [])]
    const generations = new Set<string | undefined>()
    for (const entry of entries) {
      if (!entry.receipt.closed || entry.receipt.binding.owner.conversationId !== conversationId
        || commandInputHash(entry.receipt) !== entry.digest || generations.has(entry.receipt.binding.generation)) {
        throw new Error('Conversation archive changed: recovery required')
      }
      generations.add(entry.receipt.binding.generation)
    }
    return entries.map(entry => entry.receipt)
  }

  async save(receipt: WorkerConversationReceipt) {
    const record = WorkerConversationReceiptSchema.parse(receipt)
    if (!record.closed) throw new Error('Positive conversation closure required')
    const serialized = JSON.stringify({ receipt: record, digest: commandInputHash(record) })
    if (Buffer.byteLength(serialized) > this.byteLimit + 1024) throw new Error('Conversation archive byte limit reached')
    await this.write(this.generationPath(record.binding.owner.conversationId, record.binding.generation), serialized)
  }
}
