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
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  description?: string | null;
  usable: boolean;
  notReadyReason?: string;
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
      entries.push({
        id: `custom:${provider.id}:${modelId}`,
        providerId: provider.id,
        providerLabel: provider.label,
        modelId,
        modelLabel: metadata.description || modelId,
        supportsMultimodal: Boolean(metadata.supportsMultimodal ?? inferSupportsMultimodal(modelId)),
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
