import { describe, expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents';
import { completeInterruptedAgentHistory, recoverInterruptedAgentRequestHistory } from './agentInterruptedHistory';
const call = (id: string): Extract<AgentInputItem, { type: 'function_call' }> => ({ type: 'function_call', callId: id, name: 'stage_command', arguments: '{}' });
const result = (id: string): Extract<AgentInputItem, { type: 'function_call_result' }> => ({ type: 'function_call_result', callId: id, name: 'stage_command', status: 'completed', output: 'actual result' });
const user: AgentInputItem = { role: 'user', content: 'Continue' };

describe('abandoned tool history', () => {
  it('keeps completed parallel results intact and closes only missing results before a new message', () => {
    const history = [call('one'), call('two'), result('two'), user];
    const fixed = completeInterruptedAgentHistory(history);
    expect(fixed.slice(0, 3)).toEqual(history.slice(0, 3));
    expect(fixed[3]).toMatchObject({ type: 'function_call_result', callId: 'one', output: expect.stringContaining('interrupted_without_result') });
    expect(fixed[3]).toMatchObject({ output: expect.stringContaining('unconfirmed') });
    expect(fixed[4]).toEqual(user);
    expect(completeInterruptedAgentHistory(fixed)).toEqual(fixed);
    expect(history).toHaveLength(4);
  });
  it('recovers existing output from a receipt rather than executing a tool again', () => {
    const fixed = completeInterruptedAgentHistory([call('done')], () => ({ id: 'receipt', executionId: 'execution', approvalId: 'approval',
      idempotencyKey: 'once', status: 'succeeded', createdAt: 1, updatedAt: 2, output: { objectId: 'already-created' } }));
    expect(fixed[1]).toMatchObject({ callId: 'done', output: expect.stringContaining('already-created') });
    expect(fixed[1]).toMatchObject({ output: expect.stringContaining('succeeded') });
  });
  it('preserves uncertain submission receipts as uncertain, including original job recovery metadata', () => {
    const fixed = completeInterruptedAgentHistory([call('maybe')], () => ({ id: 'receipt', executionId: 'execution', approvalId: 'approval',
      idempotencyKey: 'once', status: 'unknown', createdAt: 1, updatedAt: 2,
      safeRecovery: { kind: 'generation-status', nodeIds: ['n'], jobIds: ['original-job'] } }));
    expect(fixed[1]).toMatchObject({ output: expect.stringContaining('"receiptStatus":"unknown"') });
    expect(fixed[1]).toMatchObject({ output: expect.stringContaining('original-job') });
  });
  it('does not attach orphaned legacy results to a different tool call or erase user messages', () => {
    expect(completeInterruptedAgentHistory([user, result('orphan'), call('pending')])).toEqual([
      user, call('pending'), expect.objectContaining({ callId: 'pending', type: 'function_call_result' }),
    ]);
  });
  it('retains namespaces when closing unanswered calls', () => {
    expect(completeInterruptedAgentHistory([{ type: 'function_call', callId: 'namespaced', name: 'read', namespace: 'scene', arguments: '{}' }])[1])
      .toMatchObject({ type: 'function_call_result', callId: 'namespaced', namespace: 'scene', name: 'read' });
  });
  it('merges a partially saved parallel batch before its results and preserves existing result payloads', () => {
    const saved = [user, call('one'), result('one')];
    const request = [user, call('one'), call('two'), { ...result('one'), output: 'stale SDK result' }, result('two')];
    const recovered = recoverInterruptedAgentRequestHistory(saved, request);
    expect(recovered).toEqual([user, call('one'), call('two'), result('one'), result('two')]);
    expect(saved).toEqual([user, call('one'), result('one')]);
  });
  it('refuses request-history recovery when another turn has appended a message', () => {
    const request = [user, call('one'), result('one')];
    const saved = [...request, { role: 'user' as const, content: 'Newer turn' }];
    expect(recoverInterruptedAgentRequestHistory(saved, request)).toBeUndefined();
  });
});
