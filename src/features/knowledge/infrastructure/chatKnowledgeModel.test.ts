import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { createKnowledgeModelPort } from './chatKnowledgeModel';

const mocks = vi.hoisted(() => ({ submit: vi.fn(), catalog: [] as ChatCatalogEntry[] }));
vi.mock('@/features/channels/runtime/channelChat', () => ({ submitCustomChatCompletion: mocks.submit }));
vi.mock('@/features/channels/application/channelCatalog', () => ({ getChannelCatalogProviders: () => [] }));
vi.mock('@/features/canvas/application/chatModelCatalog', () => ({ buildChatModelCatalog: () => mocks.catalog }));

const selected: ChatCatalogEntry = { id: 'custom:selected:model', modelId: 'model', providerId: 'selected', providerLabel: 'Selected', modelLabel: 'Model',
  usable: true, supportsMultimodal: false, supportsTools: true, supportsStreaming: false, supportsReasoningSummary: false, supportsToolSearch: false, agentProtocol: 'openai-chat-completions' };

beforeEach(() => { mocks.catalog = [selected]; mocks.submit.mockReset(); });

describe('knowledge selected turn model port', () => {
  it('uses only the provided model and messages, with no undeclared generation parameters', async () => {
    mocks.catalog = [{ ...selected, id: 'custom:other:default' }, selected];
    mocks.submit.mockResolvedValue({ text: '```json\n{"kind":"tag","notes":[]}\n```' });
    const request = { system: 'Only organize the supplied notes.', prompt: '{"notes":[]}', jsonSchema: { type: 'object' } };
    await expect(createKnowledgeModelPort(selected)(request)).resolves.toBe('{"kind":"tag","notes":[]}');
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(selected.id, { messages: [
      { role: 'system', content: 'Only organize the supplied notes.\nJSON Schema: {"type":"object"}' },
      { role: 'user', content: request.prompt },
    ] });
  });
  it('never auto-selects a fallback when the explicit model disappears or becomes unavailable', async () => {
    mocks.catalog = [{ ...selected, id: 'custom:other:default' }];
    await expect(createKnowledgeModelPort(selected)({ system: 'S', prompt: 'P', jsonSchema: {} })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('does not retry a possibly accepted paid request', async () => {
    mocks.submit.mockRejectedValue(new Error('Connection closed after submit'));
    await expect(createKnowledgeModelPort(selected)({ system: 'S', prompt: 'P', jsonSchema: {} })).rejects.toThrow('Connection closed');
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
});
