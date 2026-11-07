import { describe, expect, it } from 'vitest';
import { estimateAgentRequestContext, recordAgentContextRequest, recordAgentContextResponse, readAgentContextUsage } from './agentContextUsage';
import type { AgentModelTurnRequest } from '../domain/agentModel';

describe('actual request context accounting', () => {
  it('counts system/tools/hidden continuation/tool results while excluding inline binary', () => {
    const body = { messages: [{ role: 'system', content: '系统提示'.repeat(100) }, { role: 'assistant', content: '', reasoning_content: 'private'.repeat(100) }, { role: 'tool', content: 'result'.repeat(200) }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(100000)}` } }] }], tools: [{ type: 'function', function: { name: 'canvas', parameters: { description: 'schema'.repeat(500) } } }] };
    const estimate = estimateAgentRequestContext(body);
    expect(estimate.breakdown.system).toBeGreaterThan(400);
    expect(estimate.breakdown.tools).toBeGreaterThan(700);
    expect(estimate.breakdown.conversation).toBeGreaterThan(400);
    expect(estimate.images).toBe(1);
    expect(estimate.breakdown.media).toBe(1000);
    expect(Object.values(estimate.breakdown).reduce((a,b)=>a+b,0)).toBeLessThan(5000);
  });
  it('counts Gemini system instructions and does not carry a stale response into a newer request', () => {
    expect(estimateAgentRequestContext({ systemInstruction: { parts: [{ text: 'instruction'.repeat(100) }] }, contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }).breakdown.system).toBeGreaterThan(250);
    const request: AgentModelTurnRequest = { model: { contextSessionId: 'context-test', catalogId: 'model', providerId: 'provider', modelId: 'model', label: 'Model', usable: true, capabilities: { protocol: 'openai-chat-completions', tools: true, stream: true, vision: false, reasoningSummary: false, toolSearch: false } }, input: [], tools: [] };
    const first = recordAgentContextRequest(request, { messages: [{ role: 'user', content: 'first' }] });
    const second = recordAgentContextRequest(request, { messages: [{ role: 'user', content: 'second' }], tools: [{ name: 'tool' }] });
    recordAgentContextResponse('context-test', first, { inputTokens: 900, outputTokens: 10, totalTokens: 910 });
    expect(readAgentContextUsage('context-test')?.basis).toBe('estimated');
    recordAgentContextResponse('context-test', second, { inputTokens: 1000, outputTokens: 20, totalTokens: 1020, cachedInputTokens: 800 });
    const saved = readAgentContextUsage('context-test')!;
    expect(saved.basis).toBe('provider');expect(saved.usedTokens).toBe(1000);expect(saved.cachedTokens).toBe(800);
    expect(Object.values(saved.breakdown).reduce((a,b)=>a+b,0)).toBe(1000);
    expect(JSON.stringify(saved)).not.toContain('second');
  });
  it('keeps optional estimates and malformed provider usage from failing the request lifecycle', () => {
    const request: AgentModelTurnRequest = { model: { contextSessionId: 'context-metric-failure', catalogId: 'model', providerId: 'provider', modelId: 'model', label: 'Model', usable: true,
      capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: false, reasoningSummary: false, toolSearch: false } }, input: [], tools: [] };
    expect(() => recordAgentContextRequest(request, { messages: 'provider-specific-body' })).not.toThrow();
    expect(recordAgentContextRequest(request, { messages: 'provider-specific-body' })).toBeUndefined();
    const requestId = recordAgentContextRequest(request, { messages: [{ role: 'user', content: 'Hello' }] });
    expect(() => recordAgentContextResponse(request.model.contextSessionId, requestId, { inputTokens: Infinity, outputTokens: 4, totalTokens: Infinity })).not.toThrow();
    expect(readAgentContextUsage('context-metric-failure')?.basis).toBe('estimated');
  });
});
