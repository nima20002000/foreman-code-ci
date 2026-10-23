import { z } from 'zod'
export { CurrentWorkflowCreateInputSchema, type CurrentWorkflowCreateInput } from './currentAuthoring.js'
import { WorkspaceDetailsRecordFields } from '../index.js'
import { ManagedWorkflowRecordFields, ManagementPageInfoSchema, ExpectedRevisionSchema,
  RepeatCapabilitiesResultSchema } from '../management/index.js'
import { WorkflowDefinitionCurrentSchema, WorkflowVersionCurrentSchema, WorkflowRunCurrentSchema, RunDetailsCurrentSchema } from './saved.js'
import { sameWorkflowValue } from './meaningfulEdit.js'

/** Current product reads. Retired or missing execution tags fail, including on
 * historical selection. Saved revision numbers and wire protocol versions are independent. */
export const CurrentManagedWorkflowSchema = z.object({ ...ManagedWorkflowRecordFields, workflow: WorkflowDefinitionCurrentSchema }).strict()
export const CurrentManagedWorkflowPageSchema = z.object({
  items: z.array(CurrentManagedWorkflowSchema), pageInfo: ManagementPageInfoSchema,
  orderRevision: ExpectedRevisionSchema.default(0),
}).strict()
export const CurrentManagedWorkflowCommandResultSchema = z.object({ value: CurrentManagedWorkflowSchema, replayed: z.boolean() }).strict()
export const CurrentWorkspaceDetailsSchema = z.object({ ...WorkspaceDetailsRecordFields, workflows: z.array(WorkflowDefinitionCurrentSchema) }).strict()
export const CurrentGetWorkflowResponseSchema = z.object({ workflow: WorkflowDefinitionCurrentSchema }).strict()
export const CurrentWorkflowVersionDetailSchema = z.object({ version: WorkflowVersionCurrentSchema }).strict()
export const CurrentWorkflowVersionPageSchema = z.object({ items: z.array(WorkflowVersionCurrentSchema), pageInfo: ManagementPageInfoSchema }).strict()
export const CurrentRunPageSchema = z.object({ items: z.array(WorkflowRunCurrentSchema), pageInfo: ManagementPageInfoSchema }).strict()
export const CurrentRunDetailsSchema = RunDetailsCurrentSchema
export const CurrentRunVersionSnapshotSchema = z.object({ run: WorkflowRunCurrentSchema, version: WorkflowVersionCurrentSchema }).strict()
  .superRefine(({ run, version }, context) => {
    if (run.workflowVersionId !== version.id || run.workspaceId !== version.workspaceId || run.workflowId !== version.workflowId
      || !sameWorkflowValue(run.agentConfigurationVersionIds, version.agentConfigurationVersionIds)
      || !sameWorkflowValue(run.approval, version.approval)
      || !sameWorkflowValue(run.executionCondition, version.definition.executionCondition)) {
      context.addIssue({ code: 'custom', message: 'RUN_VERSION_SNAPSHOT_PIN_MISMATCH' })
    }
  })

/** Decoder only, NOT a capability grant. False remains false. A/B production
 * composition is solely responsible for publishing true after qualification. */
export const CurrentWorkflowCapabilitiesSchema = RepeatCapabilitiesResultSchema.extend({
  supported: z.boolean(),
  availability: RepeatCapabilitiesResultSchema.shape.availability.extend({
    runtimeAdmission: z.boolean(), meaningfulEdit: z.boolean(), reasons: z.array(z.string().min(1)),
  }).strict(),
}).strict()
export type CurrentWorkspaceDetails = z.infer<typeof CurrentWorkspaceDetailsSchema>
export type CurrentGetWorkflowResponse = z.infer<typeof CurrentGetWorkflowResponseSchema>
export type CurrentRunDetails = z.infer<typeof CurrentRunDetailsSchema>
