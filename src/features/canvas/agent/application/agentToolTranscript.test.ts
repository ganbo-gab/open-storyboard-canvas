import { describe, expect, it } from 'vitest';
import type { AgentModelInputItem } from '../domain/agentModel';
import { assertCompleteAgentToolTranscript } from './agentToolTranscript';
const call = (id: string): AgentModelInputItem => ({ type: 'function_call', callId: id, name: 'read', arguments: '{}' });
const output = (id: string): AgentModelInputItem => ({ type: 'function_call_result', callId: id, name: 'read', output: '{}' });
const message: AgentModelInputItem = { type: 'message', role: 'user', content: [{ type: 'text', text: 'Continue' }] };
describe('provider tool transcript guard', () => {
  it('accepts complete parallel and sequential batches with results arriving out of order', () => {
    expect(() => assertCompleteAgentToolTranscript([message, call('a'), call('b'), output('b'), output('a'), message, call('c'), output('c')])).not.toThrow();
  });
  it.each([
    [call('a'), call('b'), output('a'), message, output('b')], [call('a')], [output('orphan')],
    [call('duplicate'), call('duplicate')], [call('a'), output('a'), output('a')],
  ])('rejects an incomplete or duplicated tool batch before transmission', (...items) => {
    expect(() => assertCompleteAgentToolTranscript(items)).toThrow(/未向供应商发送/);
  });
});
