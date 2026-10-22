import { z } from 'zod'

/** One error the web app saw, sent to the API's append-only app error log. */
export const AppErrorReportSchema = z.object({
  /** Where it was caught: window-error, unhandled-rejection, react, query, mutation or alert. */
  kind: z.string().trim().min(1).max(40),
  message: z.string().max(4000),
  stack: z.string().max(16_000).optional(),
  url: z.string().max(2000).optional(),
  method: z.string().max(16).optional(),
  status: z.number().int().optional(),
  code: z.string().max(120).optional(),
  requestId: z.string().max(120).optional(),
  buildId: z.string().max(128).optional(),
}).strict()
export type AppErrorReport = z.infer<typeof AppErrorReportSchema>

/** Workspace, workflow and run ids named in an app or API address, when it names them. */
export function appErrorResourceIds(url: string | undefined): { workspaceId?: string; workflowId?: string; runId?: string } {
  const id = (name: string) => url?.match(new RegExp(`(?:/${name}s/|[?&]${name}(?:Id)?=)([\\w-]+)`))?.[1]
  const workspaceId = id('workspace'), workflowId = id('workflow'), runId = id('run')
  return { ...(workspaceId ? { workspaceId } : {}), ...(workflowId ? { workflowId } : {}), ...(runId ? { runId } : {}) }
}
