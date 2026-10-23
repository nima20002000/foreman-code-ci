import { readFile } from 'node:fs/promises'
import type { z } from 'zod'
import type { CiContext } from './environment.js'

type Report<T> = { state: 'complete'; data: T } | { state: 'absent' | 'pending' }

export async function readCiReport<T>(context: CiContext, path: string, schema: z.ZodType<T>): Promise<Report<T>> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    if (parsed.success) return { state: 'complete', data: parsed.data }
    context.log.warn({ err: parsed.error, report: path }, 'CI report validation remains pending')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    context.log.warn({ err: error, report: path }, 'CI report read remains pending')
  }
  return { state: 'pending' }
}
