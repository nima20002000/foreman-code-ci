import { WorkflowWorktreeSettingsSchema } from '../worktreeSettings.js'
import { z } from 'zod'
import { CurrentCommonGraphOperationSchema } from '../management/index.js'
import { WorkflowRelationshipSchema, WorkflowChoiceSchema } from './workflow.js'
import { CurrentWorkflowNodeSchema } from './currentWorkflowFoundation.js'
import { RepeatPlanV1Schema } from './repeat.js'
import {
  CurrentEditIntentSchema, CurrentEditReadResultSchema, CurrentEditStageInputSchema, CurrentEditReadInputSchema,
  CurrentEditAdvanceInputSchema, CurrentEditDiscardInputSchema,
} from './currentEditIntent.js'

/** Board-local authoring vocabulary. The Board diffs its local V3 graph into these
 * operations; Agent operations call the Agent service and the complete graph is
 * saved through the shared current definition writer. There is no server draft. */
const WorkflowNodeCurrentSchema = CurrentWorkflowNodeSchema
export type WorkflowNodeCurrent = z.infer<typeof WorkflowNodeCurrentSchema>
export const GraphDraftOperationCurrentSchema = z.union([
  z.object({ type: z.literal('workflow.set_worktree'), worktree: WorkflowWorktreeSettingsSchema.nullable() }).strict(),
  z.object({ type: z.literal('workflow.set_entry'), entryNodeId: z.string().nullable() }).strict(),
  z.object({ type: z.literal('node.set_choice'), nodeId: z.string(), choice: WorkflowChoiceSchema.nullable() }).strict(),
  z.object({ type: z.literal('relationship.put'), relationship: WorkflowRelationshipSchema }).strict(),
  z.object({ type: z.literal('node.replace_v3'), node: WorkflowNodeCurrentSchema }).strict(),
  z.object({ type: z.literal('workflow.restore_version_v3'), versionId: z.string() }).strict(),
  // null is an explicit removal command, never a saved repeat value.
  z.object({ type: z.literal('workflow.set_repeat'), repeat: RepeatPlanV1Schema.nullable() }).strict(),
  CurrentCommonGraphOperationSchema,
])
export type GraphDraftOperationCurrent = z.infer<typeof GraphDraftOperationCurrentSchema>

/** Board names for the shared current edit-intent journal contracts. */
export const GraphEditIntentCurrentSchema = CurrentEditIntentSchema
export type GraphEditIntentCurrent = z.infer<typeof CurrentEditIntentSchema>
export const GraphEditReadResultCurrentSchema = CurrentEditReadResultSchema
export type GraphEditReadResultCurrent = z.infer<typeof CurrentEditReadResultSchema>
export const GraphEditStageInputCurrentSchema = CurrentEditStageInputSchema
export type GraphEditStageInputCurrent = z.infer<typeof CurrentEditStageInputSchema>
export const GraphEditReadInputCurrentSchema = CurrentEditReadInputSchema
export type GraphEditReadInputCurrent = z.infer<typeof CurrentEditReadInputSchema>
export const GraphEditAdvanceInputCurrentSchema = CurrentEditAdvanceInputSchema
export type GraphEditAdvanceInputCurrent = z.infer<typeof CurrentEditAdvanceInputSchema>
export const GraphEditDiscardInputCurrentSchema = CurrentEditDiscardInputSchema
export type GraphEditDiscardInputCurrent = z.infer<typeof CurrentEditDiscardInputSchema>
