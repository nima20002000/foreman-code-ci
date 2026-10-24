import { describe, expect, it } from 'vitest';
import { ChatSendRequestSchema, ChatSendModeContextSchema, ChatDeliveryReceiptSchema, ChatControlReceiptSchema,
  WorkflowControlContinuationSchema, legacyAgentChatIntent, legacyAgentChatStopScope, operatorChatDeliveryMode } from './chatDelivery.js';
import { EngineChatReadbackSchema, validateEngineChatReadback } from './engineChat.js';
import { collaborationContractFixtures as fixture } from './collaborationFixtures.js';

describe('shared live delivery contracts', () => {
  const target = fixture.executionReadback.target;
  const send = { target, intent: 'auto', content: 'Continue this task.' };
  const receipt = { id: 'receipt', commandId: 'command', target, requestedIntent: 'auto', appliedIntent: 'next_turn',
    state: 'queued', createdAt: fixture.createdAt, updatedAt: fixture.createdAt };

  it('preserves omitted legacy send and stop behavior', () => {
    expect(legacyAgentChatIntent()).toBe('next_turn');
    expect(legacyAgentChatStopScope()).toBe('active_and_queued');
    expect(legacyAgentChatIntent('auto')).toBe('auto');
    expect(legacyAgentChatStopScope('active_turn')).toBe('active_turn');
    expect(operatorChatDeliveryMode()).toBe('legacy');
    expect(operatorChatDeliveryMode('auto')).toBe('explicit');
  });

  it('accepts text or attachments and only same-mode text steering', () => {
    expect(ChatSendRequestSchema.parse(send)).toMatchObject({ content: send.content, attachments: [] });
    expect(ChatSendRequestSchema.safeParse({ ...send, content: ' ' }).success).toBe(false);
    const attachments = [{ fileId: 'file', revisionId: 'revision' }];
    expect(ChatSendRequestSchema.safeParse({ ...send, content: '', attachments }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ ...send, intent: 'steer', attachments }).success).toBe(false);
    expect(ChatSendModeContextSchema.safeParse({ request: { ...send, intent: 'steer', sessionMode: 'plan' }, activeSessionMode: 'plan' }).success).toBe(true);
    expect(ChatSendModeContextSchema.safeParse({ request: { ...send, intent: 'steer', sessionMode: 'plan' }, activeSessionMode: 'regular' }).success).toBe(false);
    expect(ChatSendRequestSchema.safeParse({ ...send, content: 'é'.repeat(500_000) }).success).toBe(false);
  });

  it('never silently changes explicit intent or interrupts automatically', () => {
    expect(ChatDeliveryReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(ChatDeliveryReceiptSchema.safeParse({ ...receipt, requestedIntent: 'steer' }).success).toBe(false);
    expect(ChatDeliveryReceiptSchema.safeParse({ ...receipt, appliedIntent: 'interrupt_and_send' }).success).toBe(false);
    expect(ChatDeliveryReceiptSchema.safeParse({ ...receipt, appliedIntent: 'steer' }).success).toBe(true);
    expect(ChatDeliveryReceiptSchema.safeParse({ ...receipt, continuationId: 'continuation',
      continuationExecution: { ...fixture.execution, executionId: 'successor', attempt: 2 } }).success).toBe(true);
    expect(ChatDeliveryReceiptSchema.safeParse({ ...receipt, continuationId: 'continuation',
      continuationExecution: { ...fixture.execution, executionId: 'successor', runId: 'other' } }).success).toBe(false);
  });

  it('reserves a successor without claiming native settlement or changing logical work', () => {
    const continuation = { id: 'continuation', controlCommandId: 'command', deliveryReceiptId: 'receipt',
      work: fixture.work, previousExecution: fixture.execution,
      nativeTarget: { nativeSessionId: 'session', ownerRequestId: 'original-request' },
      cause: 'interrupt_and_send', state: 'reserved', successorExecution: null, errorCode: null,
      createdAt: fixture.createdAt, updatedAt: fixture.createdAt };
    expect(WorkflowControlContinuationSchema.safeParse(continuation).success).toBe(true);
    expect(WorkflowControlContinuationSchema.safeParse({ ...continuation, state: 'admitted' }).success).toBe(false);
    const successorExecution = { ...fixture.execution, executionId: 'successor', attempt: 2 };
    expect(WorkflowControlContinuationSchema.safeParse({ ...continuation, state: 'admitted', successorExecution }).success).toBe(true);
    expect(WorkflowControlContinuationSchema.safeParse({ ...continuation, state: 'admitted', successorExecution: { ...successorExecution, activationId: 'other' } }).success).toBe(false);
    expect(WorkflowControlContinuationSchema.safeParse({ ...continuation, state: 'failed' }).success).toBe(false);
    expect(ChatControlReceiptSchema.safeParse({ commandId: 'command', target: fixture.consultationReadback.target,
      operation: 'stop_active', state: 'settling', affectedReceiptIds: [], replayed: false, consultationId: 'consultation', continuationId: 'forged' }).success).toBe(false);
  });
});

describe('Run-owned native message readback', () => {
  it('reads executions with exact provenance and no standalone conversation', () => {
    const value = validateEngineChatReadback({ subject: { kind: 'execution', agent: fixture.agent, execution: fixture.execution }, readback: fixture.executionReadback });
    expect(value.messages[0]).not.toHaveProperty('conversationId');
    expect(value.messages[0]).toMatchObject({ id: fixture.nativeMessage.id, revision: '2', sequence: '1' });
    expect(EngineChatReadbackSchema.safeParse({ ...value, messages: [{ ...value.messages[0], provenance: { kind: 'execution', execution: { ...fixture.execution, executionId: 'other' } } }] }).success).toBe(false);
  });

  it('accepts recorded consultation history and rejects a fabricated binding', () => {
    const subject = { kind: 'coordinator_consultation' as const, agent: fixture.agent, binding: fixture.binding };
    const older = { ...fixture.binding, consultationId: 'older' };
    const readback = { ...fixture.consultationReadback, messages: [
      ...fixture.consultationReadback.messages, { ...fixture.nativeMessage, id: 'older-message', provenance: { kind: 'consultation' as const, binding: older } },
    ] };
    expect(validateEngineChatReadback({ subject, readback, consultationBindings: [fixture.binding, older] }).messages).toHaveLength(2);
    expect(() => validateEngineChatReadback({ subject, readback })).toThrow();
    const foreign = { ...fixture.binding, workflowVersionId: 'other-version' };
    expect(() => validateEngineChatReadback({ subject, readback: { ...fixture.consultationReadback,
      messages: [{ ...fixture.nativeMessage, provenance: { kind: 'consultation', binding: foreign } }] }, consultationBindings: [foreign] })).toThrow();
  });
});
