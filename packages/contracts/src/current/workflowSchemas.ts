import { z } from 'zod'
import { RepeatWorkflowVersionV1Schema, RepeatWorkflowRunV1Schema } from './repeat.js'

/** Canonical V3 family, without management response DTO dependencies. */
export { WorkflowDefinitionCurrentSchema } from './workflowShape.js'
export type { WorkflowDefinitionCurrent } from './workflowShape.js'
export const WorkflowVersionCurrentSchema = RepeatWorkflowVersionV1Schema
export const WorkflowRunCurrentSchema = RepeatWorkflowRunV1Schema
export type WorkflowVersionCurrent = z.infer<typeof WorkflowVersionCurrentSchema>
export type WorkflowRunCurrent = z.infer<typeof WorkflowRunCurrentSchema>
