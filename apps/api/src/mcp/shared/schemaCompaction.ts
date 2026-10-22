/** Emitted JSON Schema only; validation always uses the tool's own zod schema. */
export function compactJsonSchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map(compactJsonSchema) as T
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>
  const formatted = record.format === 'uuid' || record.format === 'date-time'
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === '$schema' || key === 'pattern' && formatted) continue
    out[key] = compactJsonSchema(value)
  }
  return out as T
}

/** The first sentence, for compact tool listings. */
export function firstSentence(text: string | undefined): string {
  const value = (text ?? '').trim()
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(value)
  return (match ? match[0] : value).trim()
}
