import { readFile, stat } from 'node:fs/promises'
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

  async read(conversationId: string, generation?: string): Promise<WorkerConversationReceipt | undefined> {
    return (await this.readAll(conversationId)).find(record => record.binding.generation === generation)
  }

  async readAll(conversationId: string): Promise<WorkerConversationReceipt[]> {
    const path = this.recordPath(conversationId)
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
    const records = await this.readAll(record.binding.owner.conversationId)
    const index = records.findIndex(item => item.binding.generation === record.binding.generation)
    if (index >= 0) records[index] = record
    else records.push(record)
    const entries = records.map(receipt => ({ receipt, digest: commandInputHash(receipt) }))
    await this.write(this.recordPath(record.binding.owner.conversationId),
      JSON.stringify({ ...entries[0]!, ...(entries.length > 1 ? { generations: entries.slice(1) } : {}) }))
  }
}
