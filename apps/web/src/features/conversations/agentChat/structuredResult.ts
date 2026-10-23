import { canonicalJson } from '@foreman-code/contracts/canonical-json'

/** True when both messages carry the same structured turn result; Claude can repeat its final result as a second message. */
export function sameStructuredResult(left: string, right: string): boolean {
  const first = structuredResult(left), second = structuredResult(right)
  return !!first && !!second && canonicalJson(first.value) === canonicalJson(second.value)
}

const summaryKeys = ['summary', 'body', 'message', 'reason', 'text'] as const
export function structuredResult(content: string): { value: unknown; summary: string | undefined } | undefined {
  // Also a result the Agent ends with in a fenced block after some prose ("Here is the result: ```json …```").
  const text = content.trim().replace(/^(?:[\s\S]*\n)?```(?:json)?\s*(\{[\s\S]*?\})\s*```$/, '$1')
  if (!text.startsWith('{')) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined } // ignore: plain text that merely starts with a brace
  if (!value || typeof value !== 'object' || !('routing' in value || 'board' in value || 'result' in value)) return undefined
  return { value, summary: findSummary(value, 0) }
}
function findSummary(value: unknown, depth: number): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined
  for (const key of summaryKeys) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field === 'string' && field.trim()) return field
  }
  for (const child of Object.values(value)) {
    const found = findSummary(child, depth + 1)
    if (found) return found
  }
  return undefined
}
