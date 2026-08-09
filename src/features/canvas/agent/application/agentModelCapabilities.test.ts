import { describe, expect, it } from 'vitest';

import type { ChatCatalogEntry } from '../../application/chatModelCatalog';
import { listUsableAgentModels, resolveAgentModelReference } from './agentModelCapabilities';

function entry(overrides: Partial<ChatCatalogEntry> = {}): ChatCatalogEntry {
  return {
    id: 'custom:provider:model',
    providerId: 'provider',
    providerLabel: 'Provider',
    modelId: 'model',
    modelLabel: 'Model',
    supportsMultimodal: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsReasoningSummary: false,
    supportsToolSearch: false,
    agentProtocol: 'openai-chat-completions',
    usable: true,
    ...overrides,
  };
}

describe('agent model capabilities', () => {
  it('keeps protocol capabilities explicit', () => {
    expect(resolveAgentModelReference(entry({
      supportsMultimodal: true,
      supportsReasoningSummary: true,
      supportsToolSearch: true,
      agentProtocol: 'openai-responses',
    }))).toMatchObject({
      usable: true,
      capabilities: {
        protocol: 'openai-responses',
        tools: true,
        stream: true,
        vision: true,
        reasoningSummary: true,
        toolSearch: true,
      },
    });
  });

  it('fails closed when a configured text model has no tool capability', () => {
    const resolved = resolveAgentModelReference(entry({ supportsTools: false }));
    expect(resolved.usable).toBe(false);
    expect(resolved.notReadyReason).toContain('工具调用');
    expect(listUsableAgentModels([entry(), entry({ id: 'plain', supportsTools: false })]))
      .toHaveLength(1);
  });
});
