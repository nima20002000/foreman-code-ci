/**
 * Guidance beyond a tool's one- or two-sentence description. It travels in the tool's _meta, so
 * tools/list stays small, and tool_schema serves it on demand.
 */
export const TOOL_DETAIL_META = 'foreman/detail'

export function toolDetail(detail: string): { _meta: Record<string, string> } {
  return { _meta: { [TOOL_DETAIL_META]: detail } }
}

export function readToolDetail(tool: { _meta?: Record<string, unknown> | undefined }): string | undefined {
  const detail = tool._meta?.[TOOL_DETAIL_META]
  return typeof detail === 'string' ? detail : undefined
}
