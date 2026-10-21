import { z } from 'zod';
import { IdSchema, GraphIdSchema } from './schemaPrimitives.js';
import { AgentIdentitySchema, AgentNodeRefSchema } from './agentIdentity.js';
import { DeliveryTargetSchema } from './chatDelivery.js';

/** Shared F3/F4 boundary. Resolving a selected node never starts or forks work. */
export const WorkflowExecutionChatSelectionSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, workflowNodeId: GraphIdSchema,
  runId: IdSchema.optional(), workflowVersionId: IdSchema.optional(), executionId: IdSchema.optional(),
  waitingActivationId: IdSchema.optional(),
  cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict().superRefine((selection, context) => {
  if ((selection.executionId || selection.waitingActivationId) && !selection.runId) context.addIssue({ code: 'custom', path: ['runId'],
    message: 'An execution or consultation selection requires its exact Run.' });
  if (selection.executionId && selection.waitingActivationId) context.addIssue({ code: 'custom', path: ['waitingActivationId'],
    message: 'Select either an execution or a waiting coordinator.' });
});
export const WorkflowExecutionChatTargetSchema = z.discriminatedUnion('kind', [
  DeliveryTargetSchema.options[0], DeliveryTargetSchema.options[1],
]);
export const WorkflowExecutionChatReadRequestSchema = z.object({
  target: WorkflowExecutionChatTargetSchema, cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
const ChoiceSchema = z.object({
  target: WorkflowExecutionChatTargetSchema, agent: AgentIdentitySchema, workflowVersionId: IdSchema,
  source: z.enum(['execution', 'direction', 'consultation']),
  state: z.enum(['queued', 'starting', 'active', 'waiting_children', 'settling', 'idle']),
}).strict();
export const WorkflowExecutionChatResolutionSchema = z.discriminatedUnion('kind', [
  ChoiceSchema.extend({ kind: z.literal('selected') }).strict(),
  z.object({ kind: z.literal('run_selection_required'), items: z.array(z.object({
    runId: IdSchema, workflowVersionId: IdSchema,
  }).strict()).max(100), nextCursor: z.string().nullable(), hasMore: z.boolean(),
  revision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('selection_required'), items: z.array(ChoiceSchema).max(100),
    nextCursor: z.string().nullable(), hasMore: z.boolean(), revision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('outside_run'), agent: AgentNodeRefSchema,
    workflowVersionId: IdSchema, reason: z.literal('NO_LIVE_RUN') }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['NODE_UNAVAILABLE', 'NO_EXECUTION', 'WORKFLOW_UNAVAILABLE']) }).strict(),
]);
export type WorkflowExecutionChatSelection = z.infer<typeof WorkflowExecutionChatSelectionSchema>;
export type WorkflowExecutionChatTarget = z.infer<typeof WorkflowExecutionChatTargetSchema>;
export type WorkflowExecutionChatReadRequest = z.infer<typeof WorkflowExecutionChatReadRequestSchema>;
export type WorkflowExecutionChatResolution = z.infer<typeof WorkflowExecutionChatResolutionSchema>;
export const WORKFLOW_EXECUTION_CHAT_ROUTE = '/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat';

export const WorkflowExecutionChatMessageRequestSchema = z.object({
  target: WorkflowExecutionChatTargetSchema,
  messageId: z.string().min(1).max(8192),
}).strict();
