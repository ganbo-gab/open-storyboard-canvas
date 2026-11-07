import { applyModelCapabilityPreset } from '../application/modelCapabilityPresets';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ChannelProfileV2, OperationKind, OperationSpec } from '../domain/profile';
import { channelProfileSchema, supportsOpenAIChatTools } from '../domain/profile';
import { migrateLegacyConfig, type UnmigratedLegacyField } from '../migrate/legacyConfig';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { channelPersistenceStorage } from './channelPersistence';
import { listModelModes } from '../application/modelModes';
import { credentialAppearsIn, credentialState, secretRefFromToken, secretStore, secretToken, type CredentialState as VaultCredentialState, type SecretRef } from '@/features/secrets/secretStore';
import { createSecretStorage, planCredentialMigration, protectCredentials } from '@/features/secrets/credentialMigration';
import { createChannelStorageBoundary } from './channelStorageValidation';

const credentialStorage = createChannelStorageBoundary(channelPersistenceStorage, createSecretStorage(channelPersistenceStorage, 'channel'));

export interface ChannelRecord {
  profile: ChannelProfileV2;
  credentialRef?: SecretRef;
  /** HTTP migrations execute natively; legacy is accepted only when hydrating old storage. */
  origin: 'native' | 'legacy';
  migrationIssues: UnmigratedLegacyField[];
  createdAt: number;
  updatedAt: number;
}
interface ChannelState {
  channels: ChannelRecord[];
  /** Legacy configuration backups contain refs only after verified vault migration. */
  migratedLegacyIds: string[];
}
export const useChannelStore = create<ChannelState>()(persist<ChannelState>(() => ({
  channels: [], migratedLegacyIds: [],
}), { name: 'channels-v2-storage', version: 2, storage: createJSONStorage(() => credentialStorage) }));

interface CredentialState { credentials: Record<string, string> }
/** Only opaque vault reference tokens are persisted; no values enter Zustand. */
const useChannelCredentialStore = create<CredentialState>()(persist<CredentialState>(() => ({ credentials: {} }), {
  name: 'channel-credentials-storage', version: 1,
  storage: createJSONStorage(() => credentialStorage),
}));
/** Legacy projection must never persist the empty defaults while async vault hydration is pending. */
export function channelStoresHydrated(): boolean {
  return useChannelStore.persist.hasHydrated() && useChannelCredentialStore.persist.hasHydrated();
}
export async function ensureChannelStoresHydrated(): Promise<void> {
  if (channelStoresHydrated()) return;
  await Promise.all([
    useChannelStore.persist.hasHydrated() ? Promise.resolve() : useChannelStore.persist.rehydrate(),
    useChannelCredentialStore.persist.hasHydrated() ? Promise.resolve() : useChannelCredentialStore.persist.rehydrate(),
  ]);
  if (!channelStoresHydrated()) throw new Error('渠道配置尚未读取完成，请稍后重试。');
}
export function subscribeChannelHydration(listener: () => void): () => void {
  const finish = () => { if (channelStoresHydrated()) listener(); };
  const offChannels = useChannelStore.persist.onFinishHydration(finish);
  const offCredentials = useChannelCredentialStore.persist.onFinishHydration(finish);
  return () => { offChannels(); offCredentials(); };
}
/** Native transport interpolation token, never the key. Use secretStore.reveal for the eye button. */
export function getChannelCredential(id: string): string {
  const value = useChannelCredentialStore.getState().credentials[id] ?? '';
  if (secretRefFromToken(value)) return value;
  const ref = useChannelStore.getState().channels.find((entry) => entry.profile.id === id)?.credentialRef;
  return ref ? secretToken(ref) : '';
}
export function getChannelCredentialRef(id: string): SecretRef | null {
  return secretRefFromToken(getChannelCredential(id));
}
export function getChannelCredentialState(id: string): VaultCredentialState {
  return credentialState(getChannelCredentialRef(id));
}
/** Explicit transaction boundary; callers must keep snapshots out of profiles and previews. */
export function snapshotChannelCredentials(): Record<string, string> {
  return { ...useChannelCredentialStore.getState().credentials };
}
export function replaceChannelCredentials(credentials: Record<string, string>): void {
  useChannelCredentialStore.setState({ credentials: Object.fromEntries(Object.entries(credentials).filter(([, value]) => secretRefFromToken(value))) });
}
export function credentialConfigured(id: string): boolean { return getChannelCredentialState(id) === 'present'; }
export async function setChannelCredential(id: string, key: string): Promise<void> {
  if (!key) { await removeChannelCredential(id); return; }
  const existing = secretRefFromToken(key);
  const ref: SecretRef = existing ?? { namespace: 'channel', id };
  const saving = existing ? secretStore.has(existing) : secretStore.set(ref, key);
  useChannelCredentialStore.setState((state) => ({ credentials: { ...state.credentials, [id]: secretToken(ref) } }));
  useChannelStore.setState((state) => ({ channels: state.channels.map((entry) => entry.profile.id === id ? { ...entry, credentialRef: ref } : entry) }));
  await saving;
}
export async function removeChannelCredential(id: string): Promise<void> {
  const ref = getChannelCredentialRef(id);
  if (ref) await secretStore.delete(ref);
  useChannelCredentialStore.setState((state) => {
    const credentials = { ...state.credentials }; delete credentials[id]; return { credentials };
  });
  useChannelStore.setState((state) => ({ channels: state.channels.map((entry) => entry.profile.id === id ? { ...entry, credentialRef: undefined } : entry) }));
}
export function subscribeChannelCredentials(listener: () => void): () => void {
  const unsubscribe = useChannelCredentialStore.subscribe(listener);
  const unsubscribeStatus = secretStore.subscribe(listener);
  return () => { unsubscribe(); unsubscribeStatus(); };
}
export function saveChannelRecord(input: unknown, origin: ChannelRecord['origin'] = 'native'): ChannelRecord {
  const profile = channelProfileSchema.parse(input);
  const previous = useChannelStore.getState().channels.find((entry) => entry.profile.id === profile.id);
  const key = getChannelCredential(profile.id);
  if (credentialAppearsIn(getChannelCredentialRef(profile.id), JSON.stringify(profile))
    || (key && JSON.stringify(profile).includes(JSON.stringify(key).slice(1, -1)))) throw new Error('渠道配置包含凭据，请仅在独立 API Key 栏填写密钥');
  const record: ChannelRecord = { profile, origin, credentialRef: getChannelCredentialRef(profile.id) ?? previous?.credentialRef, migrationIssues: previous?.migrationIssues ?? [],
    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() };
  useChannelStore.setState((state) => ({ channels: [...state.channels.filter((entry) => entry.profile.id !== profile.id), record] }));
  return record;
}
export function removeChannelRecord(id: string): void {
  useChannelStore.setState((state) => ({ channels: state.channels.filter((entry) => entry.profile.id !== id) }));
  void removeChannelCredential(id).catch(() => undefined);
}

/** Special transports retain their own adapters and must not become dead HTTP channels. */
export function isSpecialLegacyProvider(provider: CustomProviderConfig): boolean {
  return ['comfyui', 'dreamina-cli', 'local-audio', 'minimax-h3'].includes(provider.apiStyle)
    || ['comfyui', 'dreamina-cli', 'local-audio', 'minimax-h3'].includes(String(provider.extraParams?.providerKind ?? ''));
}

// Zustand subscriptions can reenter migration before the asynchronous backup commits.
// Include the in-flight union so a projection containing only special adapters cannot erase HTTP originals.
let pendingLegacyBackup: CustomProviderConfig[] | undefined;

function legacyBackup(): CustomProviderConfig[] {
  const stored = channelPersistenceStorage.getItem('legacy_custom_providers');
  const parsed = stored ? JSON.parse(stored) as CustomProviderConfig[] : [];
  const plan = planCredentialMigration(parsed, 'channel', 'legacy_custom_providers');
  void credentialStorage.getItem('legacy_custom_providers');
  return [...new Map([...plan.value, ...(pendingLegacyBackup ?? [])].map((provider) => [provider.id, provider])).values()];
}

/** Idempotent cutover. Issues remain visible, but do not hold usable HTTP requests in review-only mode. */
export function migrateLegacyProviders(providers: readonly CustomProviderConfig[]): void {
  if (!channelStoresHydrated()) return;
  if (providers.some((provider) => planCredentialMigration(provider, 'provider', provider.id).writes.length > 0)) {
    void Promise.all(providers.map((provider) => protectCredentials(provider, 'provider', provider.id)))
      .then(migrateLegacyProviders).catch(() => undefined);
    return;
  }
  const state = useChannelStore.getState();
  const originals = providers.filter((provider) => !provider.extraParams?.channelProfileId)
    .map((provider) => planCredentialMigration(provider, 'provider', provider.id).value);
  const backup = legacyBackup();
  const sources = new Map(backup.map((provider) => [provider.id, provider]));
  for (const provider of originals) sources.set(provider.id, provider);
  const pending = [...sources.values()].filter((provider) => {
    if (isSpecialLegacyProvider(provider)) return false;
    const existing = state.channels.find((entry) => entry.profile.id === provider.id);
    return existing?.origin === 'legacy' || (!existing && !state.migratedLegacyIds.includes(provider.id));
  });
  // No second plaintext backup is created. Existing backups migrate in place after read-back.
  void credentialStorage.getItem('legacy_custom_providers_raw');
  const backedUp = new Set(backup.map((provider) => provider.id));
  const added = originals.filter((provider) => !backedUp.has(provider.id));
  if (added.length) {
    const nextBackup = [...backup, ...added];
    pendingLegacyBackup = nextBackup;
    void Promise.resolve(credentialStorage.setItem('legacy_custom_providers', JSON.stringify(nextBackup)))
      .then(() => { if (pendingLegacyBackup === nextBackup) pendingLegacyBackup = undefined; })
      .catch(() => undefined);
  }
  if (!pending.length && !state.channels.some((entry) => entry.origin === 'legacy')) return;
  const channels = state.channels.filter((entry) => {
    const source = sources.get(entry.profile.id);
    return entry.origin !== 'legacy' || !source || !isSpecialLegacyProvider(source);
  });
  const migrated = new Set(state.migratedLegacyIds);
  for (const provider of pending) {
    const migration = migrateLegacyConfig(provider);
    if (!channelProfileSchema.safeParse(migration.profile).success) continue;
    const previous = channels.find((entry) => entry.profile.id === provider.id);
    if (provider.apiKey && !getChannelCredential(provider.id)) void setChannelCredential(provider.id, provider.apiKey).catch(() => undefined);
    const next: ChannelRecord = { profile: migration.profile, origin: 'native', migrationIssues: migration.unmigrated,
      credentialRef: secretRefFromToken(provider.apiKey) ?? previous?.credentialRef,
      createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() };
    const index = channels.findIndex((entry) => entry.profile.id === provider.id);
    if (index < 0) channels.push(next); else channels[index] = next;
    migrated.add(provider.id);
  }
  // A review-only profile can predate the raw backup. Its already rendered operations are still usable.
  for (let index = 0; index < channels.length; index++) {
    const entry = channels[index];
    if (entry.origin === 'legacy') channels[index] = { ...entry, origin: 'native', updatedAt: Date.now() };
  }
  useChannelStore.setState({ channels, migratedLegacyIds: [...migrated] });
}

async function migrateStoredLegacyProviders(): Promise<void> {
  if (!channelStoresHydrated()) return;
  const raw = await credentialStorage.getItem('custom-providers-storage');
  const stored = raw ? JSON.parse(raw) as { state?: { providers?: CustomProviderConfig[] } } : undefined;
  await credentialStorage.getItem('legacy_custom_providers');
  await credentialStorage.getItem('legacy_custom_providers_raw');
  const providers = await Promise.all((stored?.state?.providers ?? []).map((provider) => protectCredentials(provider, 'provider', provider.id)));
  migrateLegacyProviders(providers);
}
useChannelStore.persist.onFinishHydration(() => { void migrateStoredLegacyProviders(); });
useChannelCredentialStore.persist.onFinishHydration(() => { void migrateStoredLegacyProviders(); });
void migrateStoredLegacyProviders().catch(() => undefined);

export function channelProviderId(channelId: string, mediaType: 'image' | 'video' | 'audio' | 'chat'): string {
  return `channel-${encodeURIComponent(channelId)}-${mediaType}`;
}
export function projectChannelProviders(channels: readonly ChannelRecord[]): CustomProviderConfig[] {
  return channels.filter((entry) => entry.origin === 'native').flatMap(({ profile }) =>
    (['image', 'video', 'audio', 'chat'] as const).flatMap((mediaType) => {
      const models = profile.models.filter((model) => (model.modes ? model.modes.map((mode) => mode.operation) : model.operations).some((operation) => mediaType === 'chat'
        ? operation === 'chat' : operation.startsWith(`${mediaType}.`)));
      if (!models.length) return [];
      const projections = models.map((model) => {
        const modes: Array<{ operation: OperationKind; operationSpec?: OperationSpec }> = model.modes
          ? listModelModes(model) : model.operations.map((operation) => ({ operation }));
        const mode = modes.find((entry) => mediaType === 'chat' ? entry.operation === 'chat' : entry.operation.startsWith(`${mediaType}.`));
        const operation = mode?.operationSpec ?? (mode ? profile.operations[mode.operation] : undefined);
        const chat = mediaType === 'chat' ? operation?.template : undefined;
        const fields = chat && typeof chat === 'object' && !Array.isArray(chat) ? chat : {};
        const protocol = fields.contents === '{{chatPayload.contents}}' ? 'google-gemini' as const
          : fields.input === '{{chatPayload.input}}' ? 'openai-responses' as const
            : fields.system === '{{chatPayload.system}}' && /\/messages\/?$/.test(operation?.path ?? '') ? 'anthropic-messages' as const
              : fields.messages === '{{messages}}' ? 'openai-chat-completions' as const : undefined;
        return { model, operation, fields, protocol };
      });
      const first = projections[0];
      return [{ id: channelProviderId(profile.id, mediaType), label: profile.name, mediaType,
        baseUrl: profile.baseUrl, endpointPath: first?.operation?.path, apiStyle: 'channel-template-v2',
        apiKey: getChannelCredential(profile.id), models: models.map((model) => model.id), supportsWebSearch: false,
        credentialRef: getChannelCredentialRef(profile.id) ?? undefined, credentialState: getChannelCredentialState(profile.id),
        modelMetadata: mediaType === 'chat' ? Object.fromEntries(projections.map(({ model, operation, fields, protocol }) => {
          const capabilities = applyModelCapabilityPreset(model).capabilities;
          const params = model.modes ? listModelModes(model).filter((entry) => entry.operation === 'chat').flatMap((entry) => entry.params) : model.params;
          return [model.id, {
            supportsTools: capabilities?.supportsTools === false ? false : protocol === 'openai-chat-completions' ? supportsOpenAIChatTools({ ...profile, operations: { ...profile.operations, chat: operation } }) : Boolean(protocol && fields.tools === '{{chatPayload.tools}}'),
            supportsStreaming: capabilities?.supportsStreaming === false ? false : Boolean(protocol && params.some((param) => param.key === 'stream' && param.type === 'boolean') && (fields.stream === '{{param.stream}}' || (protocol === 'google-gemini' && operation?.path.includes('{{chatPayload.action}}') && operation.path.includes('{{chatPayload.alt}}')))),
            supportsMultimodal: capabilities?.supportsMultimodal ?? Boolean(protocol),
            contextWindow: capabilities?.contextWindow,
            maxOutputTokens: capabilities?.maxOutputTokens,
            ...(protocol ? { agentProtocol: protocol } : {}),
            description: model.label,
          }];
        })) : undefined,
        extraParams: { channelProfileId: profile.id, auth: { mode: profile.auth.type }, channelImageEncoding: first?.operation?.imageEncoding,
          // UI reads the actual parameter declarations from channelStore, never inferred transport hints.
          channelModels: models },
      } satisfies CustomProviderConfig];
    }));
}
