import { ExecutionQueueReasonSchema } from './executionQueue.js';
import { z } from 'zod';
import { ExecutionRefSchema, CoordinatorConsultationBindingSchema, AgentSubjectSchema, sameExecution, sameAgentNode } from './agentIdentity.js';
import { DeliveryTargetSchema, ChatDeliveryReceiptSchema } from './chatDelivery.js';
import { NativeSourceMessageSchema } from './messages.js';
import { canonicalJson } from './canonicalJson.js';

export const EngineChatMessageSchema =
  NativeSourceMessageSchema.extend({
    provenance: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('execution'), execution: ExecutionRefSchema }).strict(),
      z.object({ kind: z.literal('consultation'),
        binding: CoordinatorConsultationBindingSchema }).strict(),
    ]),
  }).strict().superRefine((message, context) => {
    if (message.provenance.kind === 'consultation' && message.activityNative
      && message.activityNative.sessionId !== message.provenance.binding.nativeSessionId) {
      context.addIssue({ code: 'custom', path: ['provenance'], message: 'Consultation provenance must retain the native session.' });
    }
  });
export const EngineChatReadbackSchema = z.object({
  target: DeliveryTargetSchema,
  state: z.enum(['queued','starting','active','waiting_children','settling','idle']),
  queueReason: ExecutionQueueReasonSchema.optional(),
  capabilities: z.object({ steer: z.enum(['native_expected_turn','unavailable']),
    queue: z.boolean(), interruptAndSend: z.boolean() }).strict(),
  /** Current native owner observation, independent of retained transcript messages. */
  nativeTurnId: z.string().min(1).optional(),
  messages: z.array(EngineChatMessageSchema).max(100), receipts: z.array(ChatDeliveryReceiptSchema),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strict().superRefine((readback, context) => {
  const target = readback.target;
  if (target.kind !== 'workflow_execution' && target.kind !== 'workflow_coordinator') {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Engine readback requires Run-owned work.' });
    return;
  }
  for (const [index, message] of readback.messages.entries()) {
    const source = message.provenance;
    const matches = target.kind === 'workflow_execution'
      ? source.kind === 'execution' && sameExecution(source.execution, target.execution)
      : source.kind === 'consultation' && source.binding.runId === target.runId
        && source.binding.waitingActivationId === target.waitingActivationId;
    if (!matches) context.addIssue({ code: 'custom', path: ['messages', index, 'provenance'], message: 'Message provenance must match the exact selected target.' });
  }
  if (readback.receipts.some((receipt) => canonicalJson(receipt.target) !== canonicalJson(target))) {
    context.addIssue({ code: 'custom', path: ['receipts'], message: 'Receipt targets must match the selected owner.' });
  }
}); // Existing native activity uses its current bounded activity endpoint.


export type EngineChatMessage = z.infer<typeof EngineChatMessageSchema>;
export type EngineChatReadback = z.infer<typeof EngineChatReadbackSchema>;

/** Bind readback to the owner's immutable subject and recorded consultation history.
 * The owner supplies these records; a selected target alone is not provenance proof. */
export const EngineChatReadbackContextSchema = z.object({
  subject: AgentSubjectSchema, readback: EngineChatReadbackSchema,
  consultationBindings: z.array(CoordinatorConsultationBindingSchema).optional(),
}).strict().superRefine(({ subject, readback, consultationBindings }, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const target = readback.target;
  if (target.kind === 'workflow_execution') {
    if (subject.kind !== 'execution' || !sameAgentNode(subject.agent, target.agent)
      || !sameExecution(subject.execution, target.execution)) fail('Readback must match its exact execution owner.');
    return;
  }
  if (target.kind !== 'workflow_coordinator' || subject.kind !== 'coordinator_consultation') {
    fail('Coordinator readback requires its owner-issued consultation subject.');
    return;
  }
  if (!sameAgentNode(subject.agent, target.agent) || subject.binding.runId !== target.runId
    || subject.binding.waitingActivationId !== target.waitingActivationId) fail('Readback must match the waiting coordinator.');
  const recorded = consultationBindings ?? [subject.binding];
  for (const binding of recorded) {
    if (binding.runId !== subject.binding.runId || binding.workflowVersionId !== subject.binding.workflowVersionId
      || binding.waitingActivationId !== subject.binding.waitingActivationId || binding.delegationGroupId !== subject.binding.delegationGroupId
      || binding.nativeSessionId !== subject.binding.nativeSessionId) fail('Recorded consultations must retain the same immutable waiting owner.');
  }
  for (const message of readback.messages) {
    if (message.provenance.kind !== 'consultation'
      || !recorded.some((binding) => canonicalJson(binding) === canonicalJson(message.provenance.kind === 'consultation' ? message.provenance.binding : null))) {
      fail('Consultation message requires its exact recorded binding.');
    }
  }
  for (const receipt of readback.receipts) if (receipt.consultationId && !recorded.some((binding) => binding.consultationId === receipt.consultationId)) {
    fail('Consultation receipt requires its recorded binding.');
  }
});
export type EngineChatReadbackContext = z.infer<typeof EngineChatReadbackContextSchema>;

export function validateEngineChatReadback(input: EngineChatReadbackContext): EngineChatReadback {
  return EngineChatReadbackContextSchema.parse(input).readback;
}
