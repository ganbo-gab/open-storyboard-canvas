import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ChannelProfileV2 } from '../domain/profile';
import { channelProfileSchema, supportsOpenAIChatTools } from '../domain/profile';
import { migrateLegacyConfig, type UnmigratedLegacyField } from '../migrate/legacyConfig';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { channelPersistenceStorage } from './channelPersistence';

export interface ChannelRecord {
  profile: ChannelProfileV2;
  /** Legacy records are reviewable migrations, not an implicit gateway cutover. */
  origin: 'native' | 'legacy';
  migrationIssues: UnmigratedLegacyField[];
  createdAt: number;
  updatedAt: number;
}
interface ChannelState {
  channels: ChannelRecord[];
  /** Original legacy config is backed up separately; it is never rewritten by migration. */
  migratedLegacyIds: string[];
}
export const useChannelStore = create<ChannelState>()(persist<ChannelState>(() => ({
  channels: [], migratedLegacyIds: [],
}), { name: 'channels-v2-storage', version: 2, storage: createJSONStorage(() => channelPersistenceStorage) }));

interface CredentialState { credentials: Record<string, string> }
/** Separate persistence boundary, not an encrypted vault. Never export this state in profiles/jobs. */
const useChannelCredentialStore = create<CredentialState>()(persist<CredentialState>(() => ({ credentials: {} }), {
  name: 'channel-credentials-storage', version: 1,
  storage: createJSONStorage(() => channelPersistenceStorage),
}));
export function getChannelCredential(id: string): string {
  return useChannelCredentialStore.getState().credentials[id] ?? '';
}
export function credentialConfigured(id: string): boolean { return Boolean(getChannelCredential(id).trim()); }
export function setChannelCredential(id: string, key: string): void {
  useChannelCredentialStore.setState((state) => ({ credentials: { ...state.credentials, [id]: key } }));
}
export function removeChannelCredential(id: string): void {
  useChannelCredentialStore.setState((state) => {
    const credentials = { ...state.credentials }; delete credentials[id]; return { credentials };
  });
}
export function subscribeChannelCredentials(listener: () => void): () => void {
  return useChannelCredentialStore.subscribe(listener);
}
export function saveChannelRecord(input: unknown, origin: ChannelRecord['origin'] = 'native'): ChannelRecord {
  const profile = channelProfileSchema.parse(input);
  const previous = useChannelStore.getState().channels.find((entry) => entry.profile.id === profile.id);
  const key = getChannelCredential(profile.id);
  if (key && JSON.stringify(profile).includes(JSON.stringify(key).slice(1, -1))) throw new Error('渠道配置包含凭据，请仅在独立 API Key 栏填写密钥');
  const record: ChannelRecord = { profile, origin, migrationIssues: previous?.migrationIssues ?? [],
    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() };
  useChannelStore.setState((state) => ({ channels: [...state.channels.filter((entry) => entry.profile.id !== profile.id), record] }));
  return record;
}
export function removeChannelRecord(id: string): void {
  useChannelStore.setState((state) => ({ channels: state.channels.filter((entry) => entry.profile.id !== id) }));
  removeChannelCredential(id);
}

/** Idempotent review migration: special/legacy gateways stay authoritative until explicit save. */
export function migrateLegacyProviders(providers: readonly CustomProviderConfig[]): void {
  const state = useChannelStore.getState();
  const pending = providers.filter((provider) => !provider.extraParams?.channelProfileId
    && !state.migratedLegacyIds.includes(provider.id));
  if (!pending.length) return;
  // Preserve the exact original storage including fields not representable in v2.
  // This backup intentionally retains old credentials like the original legacy store.
  const previous = channelPersistenceStorage.getItem('legacy_custom_providers');
  const backup: CustomProviderConfig[] = previous ? JSON.parse(previous) : [];
  const ids = new Set(backup.map((entry) => entry.id));
  channelPersistenceStorage.setItem('legacy_custom_providers', JSON.stringify([...backup, ...pending.filter((entry) => !ids.has(entry.id))]));
  const channels = [...state.channels];
  for (const provider of pending) {
    if (channels.some((entry) => entry.profile.id === provider.id)) continue;
    const migration = migrateLegacyConfig(provider);
    if (!channelProfileSchema.safeParse(migration.profile).success) continue;
    if (provider.apiKey) setChannelCredential(provider.id, provider.apiKey);
    channels.push({ profile: migration.profile, origin: 'legacy', migrationIssues: migration.unmigrated,
      createdAt: Date.now(), updatedAt: Date.now() });
  }
  useChannelStore.setState({ channels, migratedLegacyIds: [...state.migratedLegacyIds, ...pending.map((entry) => entry.id)] });
}

export function channelProviderId(channelId: string, mediaType: 'image' | 'video' | 'chat'): string {
  return `channel-${encodeURIComponent(channelId)}-${mediaType}`;
}
export function projectChannelProviders(channels: readonly ChannelRecord[]): CustomProviderConfig[] {
  return channels.filter((entry) => entry.origin === 'native').flatMap(({ profile }) =>
    (['image', 'video', 'chat'] as const).flatMap((mediaType) => {
      const models = profile.models.filter((model) => model.operations.some((operation) => mediaType === 'chat'
        ? operation === 'chat' : operation.startsWith(`${mediaType}.`)));
      if (!models.length) return [];
      const operation = mediaType === 'chat' ? profile.operations.chat
        : profile.operations[mediaType === 'video' ? 'video.generate' : 'image.generate'] ?? profile.operations['image.edit'];
      return [{ id: channelProviderId(profile.id, mediaType), label: profile.name, mediaType,
        baseUrl: profile.baseUrl, endpointPath: operation?.path, apiStyle: 'channel-template-v2',
        apiKey: getChannelCredential(profile.id), models: models.map((model) => model.id), supportsWebSearch: false,
        modelMetadata: mediaType === 'chat' ? Object.fromEntries(models.map((model) => [model.id, {
          supportsTools: supportsOpenAIChatTools(profile), supportsStreaming: false, supportsMultimodal: false,
          ...(supportsOpenAIChatTools(profile) ? { agentProtocol: 'openai-chat-completions' as const } : {}),
          description: model.label,
        }])) : undefined,
        extraParams: { channelProfileId: profile.id, auth: { mode: profile.auth.type },
          // UI reads the actual parameter declarations from channelStore, never inferred transport hints.
          channelModels: models },
      } satisfies CustomProviderConfig];
    }));
}
