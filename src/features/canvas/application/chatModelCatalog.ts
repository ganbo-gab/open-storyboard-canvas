import { useMemo } from 'react';

import {
  AGNES_PROVIDER_DEFAULTS,
  isChatCustomProvider,
  useCustomProvidersStore,
  type CustomProviderChatModelMetadata,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import { hasCustomProviderCredential } from '@/features/canvas/application/providerAvailability';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ChatCatalogEntry {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  supportsMultimodal: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsReasoningSummary: boolean;
  supportsToolSearch: boolean;
  agentProtocol: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages' | 'google-gemini';
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  description?: string | null;
  usable: boolean;
  notReadyReason?: string;
}

export function resolveAgentProtocol(
  provider: CustomProviderConfig,
  metadata: CustomProviderChatModelMetadata,
): ChatCatalogEntry['agentProtocol'] {
  if (metadata.agentProtocol) return metadata.agentProtocol;
  const endpoint = provider.endpointPath?.trim().toLowerCase() ?? '';
  if (/\/chat\/completions(?:$|[/?#])/.test(endpoint)) return 'openai-chat-completions';
  if (/\/responses(?:$|[/?#])/.test(endpoint)) return 'openai-responses';
  if (/\/messages(?:$|[/?#])/.test(endpoint)) return 'anthropic-messages';
  if (/(?:generatecontent|streamgeneratecontent)(?:$|[/?#:])/.test(endpoint)) return 'google-gemini';
  const providerKind = typeof provider.extraParams?.providerKind === 'string'
    ? provider.extraParams.providerKind
    : '';
  if (providerKind === 'openai-responses') return 'openai-responses';
  if (providerKind === 'anthropic-messages') return 'anthropic-messages';
  if (providerKind === 'google-gemini') return 'google-gemini';
  return 'openai-chat-completions';
}

function inferSupportsTools(
  provider: CustomProviderConfig,
  protocol: ChatCatalogEntry['agentProtocol'],
): boolean {
  if (protocol !== 'openai-chat-completions') return true;
  const endpoint = provider.endpointPath?.toLowerCase() ?? '';
  return provider.apiStyle === 'openai-compatible'
    || endpoint.includes('/chat/completions')
    || provider.extraParams?.providerKind === 'agnes-chat';
}

function inferSupportsStreaming(protocol: ChatCatalogEntry['agentProtocol']): boolean {
  return protocol !== 'google-gemini';
}

function inferSupportsToolSearch(modelId: string, protocol: ChatCatalogEntry['agentProtocol']): boolean {
  return protocol === 'openai-responses' && /^gpt-5\.6(?:-|$)/i.test(modelId);
}

function inferSupportsMultimodal(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /(gpt-(?:4o|4\.1|5|5\.4|5\.5)|gemini|claude-(?:3|4)|sonnet|opus|haiku|vision|multimodal|vl\b|qwen.*vl|llava)/i.test(id);
}

function metadataFor(
  provider: CustomProviderConfig,
  modelId: string,
): CustomProviderChatModelMetadata {
  return provider.modelMetadata?.[modelId] ?? {};
}

export function buildChatModelCatalog(
  customProviders: readonly CustomProviderConfig[],
  agnesApiKey = '',
): ChatCatalogEntry[] {
  const entries: ChatCatalogEntry[] = [];
  for (const provider of customProviders) {
    if (!isChatCustomProvider(provider)) {
      continue;
    }
    const hasBaseUrl = Boolean(provider.baseUrl?.trim());
    const hasCredential = hasCustomProviderCredential(provider);
    const usable = hasBaseUrl && hasCredential;
    for (const modelId of provider.models) {
      const metadata = metadataFor(provider, modelId);
      const agentProtocol = resolveAgentProtocol(provider, metadata);
      entries.push({
        id: `custom:${provider.id}:${modelId}`,
        providerId: provider.id,
        providerLabel: provider.label,
        modelId,
        modelLabel: metadata.description || modelId,
        supportsMultimodal: Boolean(metadata.supportsMultimodal ?? inferSupportsMultimodal(modelId)),
        supportsTools: metadata.supportsTools ?? inferSupportsTools(provider, agentProtocol),
        supportsStreaming: metadata.supportsStreaming ?? inferSupportsStreaming(agentProtocol),
        supportsReasoningSummary: metadata.supportsReasoningSummary ?? false,
        supportsToolSearch: metadata.supportsToolSearch ?? inferSupportsToolSearch(modelId, agentProtocol),
        agentProtocol,
        contextWindow: metadata.contextWindow,
        maxOutputTokens: metadata.maxOutputTokens,
        description: metadata.description,
        usable,
        notReadyReason: usable
          ? undefined
          : (hasBaseUrl ? '请在「我的配置」里填入 API Key' : '请在「我的配置」里填入 API 根地址'),
      });
    }
  }

  if (agnesApiKey.trim()) {
    for (const [modelId, label] of [
      [AGNES_PROVIDER_DEFAULTS.models.chat25Flash, 'Agnes 2.5 Flash'],
      [AGNES_PROVIDER_DEFAULTS.models.chat20Flash, 'Agnes 2.0 Flash'],
      [AGNES_PROVIDER_DEFAULTS.models.chat15Flash, 'Agnes 1.5 Flash'],
    ] as const) {
      entries.push({
        id: `agnes:chat:${modelId}`,
        providerId: 'agnes',
        providerLabel: 'Agnes',
        modelId,
        modelLabel: label,
        supportsMultimodal: true,
        supportsTools: true,
        supportsStreaming: true,
        supportsReasoningSummary: false,
        supportsToolSearch: false,
        agentProtocol: 'openai-chat-completions',
        contextWindow: 256000,
        maxOutputTokens: 65500,
        description: label,
        usable: true,
      });
    }
  }
  return entries;
}

export function useChatModelCatalog(): ChatCatalogEntry[] {
  const customProviders = useCustomProvidersStore((state) => state.providers);
  const agnesApiKey = useSettingsStore((state) => state.agnesApiKey);
  return useMemo(
    () => buildChatModelCatalog(customProviders, agnesApiKey),
    [agnesApiKey, customProviders],
  );
}
