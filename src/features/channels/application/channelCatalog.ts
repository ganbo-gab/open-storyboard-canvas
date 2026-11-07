import { useMemo, useSyncExternalStore } from 'react';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { getChannelCredential, projectChannelProviders, subscribeChannelCredentials, useChannelStore, isSpecialLegacyProvider } from '../store/channelStore';
import { modelSpecSchema, type ModelSpec } from '../domain/profile';
import { listModelModes, type ResolvedMode } from './modelModes';
import { parseCustomProviderModelId } from '@/features/canvas/application/imageProviderContracts';

/** Convert persisted pre-cutover catalog IDs without introducing duplicate picker rows. */
export function resolveChannelCatalogModelId(catalogId: string): string {
  const parsed = parseCustomProviderModelId(catalogId);
  const agnes = /^agnes:(image|video|chat):(.+)$/.exec(catalogId);
  const providers = projectChannelProviders(useChannelStore.getState().channels);
  const provider = providers.find((entry) => agnes ? entry.extraParams?.channelProfileId === `settings-agnes-${agnes[1]}`
    : parsed && entry.extraParams?.channelProfileId === parsed.providerId && entry.models.includes(parsed.upstreamModel));
  return provider ? `custom:${provider.id}:${agnes?.[2] ?? parsed!.upstreamModel}` : catalogId;
}

export function getChannelCatalogProviders(): CustomProviderConfig[] {
  return [...projectChannelProviders(useChannelStore.getState().channels), ...useCustomProvidersStore.getState().providers.filter(isSpecialLegacyProvider)];
}
/** HTTP catalog data is projected directly from authoritative channels; only special adapters use their own store. */
export function useChannelCatalogProviders(): CustomProviderConfig[] {
  const channels = useChannelStore((state) => state.channels);
  const providers = useCustomProvidersStore((state) => state.providers);
  const credentials = useSyncExternalStore(subscribeChannelCredentials,
    () => channels.map(({ profile }) => getChannelCredential(profile.id)).join('\u0000'));
  return useMemo(() => [...projectChannelProviders(channels), ...providers.filter(isSpecialLegacyProvider)], [channels, providers, credentials]);
}
export function channelModelForProvider(provider: CustomProviderConfig, modelId: string): ModelSpec | undefined {
  const models = provider.extraParams?.channelModels;
  if (!Array.isArray(models)) return undefined;
  const parsed = modelSpecSchema.safeParse(models.find((entry: unknown) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === modelId));
  return parsed.success ? parsed.data : undefined;
}
/** Full declarations (including object enum values) are the catalog's authoritative choices. */
export function channelModelModes(provider: CustomProviderConfig, modelId: string): ResolvedMode[] | undefined {
  const model = channelModelForProvider(provider, modelId);
  return model ? listModelModes(model) : undefined;
}
/**
 * Legacy scalar picker fields carry wire values, never display labels or serialized objects.
 * The list covers every mode (a value valid in any mode survives config resolution) and starts
 * with the first declaring mode's default, so `values[0]` is the declared default.
 */
export function channelParameterValues(model: ModelSpec | undefined, keys: readonly string[]): string[] | undefined {
  if (!model) return undefined;
  const params = listModelModes(model).flatMap((mode) => mode.params.filter((entry) => keys.includes(entry.key)));
  if (!params.length) return model.modes ? [] : undefined;
  const scalar = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? [String(value)] : []);
  const values = params.flatMap((param) => param.options?.flatMap((option) => scalar(option.value)) ?? scalar(param.default));
  const declaredDefault = params.flatMap((param) => scalar(param.default)).find((value) => values.includes(value));
  return [...new Set(declaredDefault === undefined ? values : [declaredDefault, ...values])];
}
