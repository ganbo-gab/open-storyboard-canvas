import { useCustomProvidersStore, type CustomProviderChatModelMetadata, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore, type GenerationNetworkRoute } from '@/stores/settingsStore';
import { redactSensitiveValue } from './agentRedaction';

const CONFIG_ROLLBACK_STORAGE_KEY = 'storyboard-copilot:canvas-agent:config-rollbacks:v1';
const MAX_CONFIG_ROLLBACKS = 200;
const GENERATION_NETWORK_CONFIG_ID = '__application_generation_network__';

export interface AgentProviderPatchV1 {
  version: 1;
  providerId: string;
  baseRevision: string;
  changes: {
    baseUrl?: string;
    endpointPath?: string;
    apiStyle?: string;
    modelId?: string;
    modelMetadata?: CustomProviderChatModelMetadata;
  };
}

export interface AgentConfigPatchPreview {
  ok: boolean;
  providerId: string;
  baseRevision: string;
  diff: Array<{ field: string; before: unknown; after: unknown }>;
  issues: string[];
  credential: 'configured' | 'missing';
}

export interface AgentConfigRollbackSnapshot {
  token: string;
  providerId: string;
  appliedRevision: string;
  previous: {
    baseUrl?: string;
    endpointPath?: string | null;
    apiStyle?: string;
    modelMetadata?: CustomProviderConfig['modelMetadata'] | null;
    generationNetworkRoute?: GenerationNetworkRoute;
  };
  createdAt: number;
}

export interface AgentConfigRollbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface AgentConfigRollbackEnvelopeV1 {
  version: 1;
  snapshots: AgentConfigRollbackSnapshot[];
}

function defaultRollbackStorage(): AgentConfigRollbackStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRollbackSnapshot(value: unknown): value is AgentConfigRollbackSnapshot {
  if (!isPlainRecord(value) || !isPlainRecord(value.previous)) return false;
  if (typeof value.token !== 'string' || !value.token
    || typeof value.providerId !== 'string' || !value.providerId
    || typeof value.appliedRevision !== 'string' || !value.appliedRevision
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0) return false;
  const allowed = new Set(['baseUrl', 'endpointPath', 'apiStyle', 'modelMetadata', 'generationNetworkRoute']);
  if (Object.keys(value.previous).some((key) => !allowed.has(key))) return false;
  if (value.previous.baseUrl !== undefined && typeof value.previous.baseUrl !== 'string') return false;
  if (value.previous.endpointPath !== undefined && value.previous.endpointPath !== null && typeof value.previous.endpointPath !== 'string') return false;
  if (value.previous.apiStyle !== undefined && typeof value.previous.apiStyle !== 'string') return false;
  if (
    value.previous.generationNetworkRoute !== undefined
    && !['system', 'direct', 'custom-proxy'].includes(value.previous.generationNetworkRoute as string)
  ) return false;
  return value.previous.modelMetadata === undefined
    || value.previous.modelMetadata === null
    || isPlainRecord(value.previous.modelMetadata);
}

function parseRollbackEnvelope(raw: string | null): AgentConfigRollbackEnvelopeV1 {
  if (!raw) return { version: 1, snapshots: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<AgentConfigRollbackEnvelopeV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.snapshots)) return { version: 1, snapshots: [] };
    return {
      version: 1,
      snapshots: parsed.snapshots.filter(isRollbackSnapshot).slice(-MAX_CONFIG_ROLLBACKS),
    };
  } catch {
    return { version: 1, snapshots: [] };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class PersistentAgentConfigRollbackStore {
  private memory: AgentConfigRollbackEnvelopeV1 = { version: 1, snapshots: [] };

  constructor(private readonly storage: AgentConfigRollbackStorage | null = defaultRollbackStorage()) {}

  get(token: string): AgentConfigRollbackSnapshot | undefined {
    const snapshot = this.read().snapshots.find((item) => item.token === token);
    return snapshot ? clone(snapshot) : undefined;
  }

  put(snapshot: AgentConfigRollbackSnapshot): void {
    if (!isRollbackSnapshot(snapshot)) throw new Error('Invalid Agent config rollback snapshot.');
    const envelope = this.read();
    const index = envelope.snapshots.findIndex((item) => item.token === snapshot.token);
    if (index >= 0) {
      const current = envelope.snapshots[index];
      if (current.providerId !== snapshot.providerId || current.appliedRevision !== snapshot.appliedRevision) {
        throw new Error('Agent config rollback token identity cannot be replaced.');
      }
      envelope.snapshots[index] = clone(snapshot);
    } else {
      envelope.snapshots.push(clone(snapshot));
    }
    envelope.snapshots = envelope.snapshots.slice(-MAX_CONFIG_ROLLBACKS);
    this.write(envelope);
  }

  delete(token: string): void {
    const envelope = this.read();
    envelope.snapshots = envelope.snapshots.filter((item) => item.token !== token);
    this.write(envelope);
  }

  private read(): AgentConfigRollbackEnvelopeV1 {
    return this.storage
      ? parseRollbackEnvelope(this.storage.getItem(CONFIG_ROLLBACK_STORAGE_KEY))
      : clone(this.memory);
  }

  private write(envelope: AgentConfigRollbackEnvelopeV1): void {
    const safe = parseRollbackEnvelope(JSON.stringify(envelope));
    if (this.storage) this.storage.setItem(CONFIG_ROLLBACK_STORAGE_KEY, JSON.stringify(safe));
    else this.memory = clone(safe);
  }
}

export const agentConfigRollbackStore = new PersistentAgentConfigRollbackStore();

function fingerprint(provider: CustomProviderConfig): string {
  const value = JSON.stringify({ id: provider.id, baseUrl: provider.baseUrl, endpointPath: provider.endpointPath, apiStyle: provider.apiStyle, models: provider.models, modelMetadata: provider.modelMetadata });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `provider-v1-${(hash >>> 0).toString(16)}`;
}

export function getAgentProviderRevision(providerId: string): string | null {
  const provider = useCustomProvidersStore.getState().providers.find((item) => item.id === providerId);
  return provider ? fingerprint(provider) : null;
}

export function getAgentGenerationNetworkRevision(): string {
  const network = useSettingsStore.getState().generationNetworkSettings;
  const value = `${network.route}|${network.customProxyUrl.trim() ? 'configured' : 'missing'}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `generation-network-v1-${(hash >>> 0).toString(16)}`;
}

export function previewAgentGenerationNetworkPatch(input: {
  baseRevision: string;
  route: GenerationNetworkRoute;
}): AgentConfigPatchPreview {
  const network = useSettingsStore.getState().generationNetworkSettings;
  const issues: string[] = [];
  if (input.baseRevision !== getAgentGenerationNetworkRevision()) {
    issues.push('配置在预览后已变化，需要重新生成补丁。');
  }
  if (input.route === 'custom-proxy' && !network.customProxyUrl.trim()) {
    issues.push('自定义代理地址尚未由用户配置；Agent 不能读取或代填代理凭据。');
  }
  const diff = input.route === network.route
    ? []
    : [{ field: 'generationNetworkSettings.route', before: network.route, after: input.route }];
  if (!diff.length) issues.push('补丁没有产生任何变化。');
  return {
    ok: issues.length === 0,
    providerId: GENERATION_NETWORK_CONFIG_ID,
    baseRevision: getAgentGenerationNetworkRevision(),
    diff,
    issues,
    credential: network.customProxyUrl.trim() ? 'configured' : 'missing',
  };
}

export function applyAgentGenerationNetworkPatch(
  input: { baseRevision: string; route: GenerationNetworkRoute },
  rollbackStore: PersistentAgentConfigRollbackStore = agentConfigRollbackStore,
): { ok: true; rollbackToken: string; revision: string; diff: AgentConfigPatchPreview['diff'] } | { ok: false; issues: string[] } {
  const preview = previewAgentGenerationNetworkPatch(input);
  if (!preview.ok) return { ok: false, issues: preview.issues };
  const network = useSettingsStore.getState().generationNetworkSettings;
  const rollbackToken = globalThis.crypto?.randomUUID?.() ?? `config-rollback-${Date.now().toString(36)}`;
  useSettingsStore.getState().setGenerationNetworkSettings({ ...network, route: input.route });
  const revision = getAgentGenerationNetworkRevision();
  try {
    rollbackStore.put({
      token: rollbackToken,
      providerId: GENERATION_NETWORK_CONFIG_ID,
      appliedRevision: revision,
      previous: { generationNetworkRoute: network.route },
      createdAt: Date.now(),
    });
  } catch (error) {
    useSettingsStore.getState().setGenerationNetworkSettings(network);
    throw error;
  }
  return { ok: true, rollbackToken, revision, diff: preview.diff };
}

function normalizedMetadata(value: CustomProviderChatModelMetadata | undefined): CustomProviderChatModelMetadata | undefined {
  if (!value) return undefined;
  return {
    supportsMultimodal: value.supportsMultimodal,
    supportsTools: value.supportsTools,
    supportsStreaming: value.supportsStreaming,
    supportsReasoningSummary: value.supportsReasoningSummary,
    supportsToolSearch: value.supportsToolSearch,
    agentProtocol: value.agentProtocol,
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    description: value.description?.slice(0, 300),
  };
}

export function previewAgentProviderPatch(patch: AgentProviderPatchV1): AgentConfigPatchPreview {
  const provider = useCustomProvidersStore.getState().providers.find((item) => item.id === patch.providerId);
  if (!provider) return { ok: false, providerId: patch.providerId, baseRevision: patch.baseRevision, diff: [], issues: ['供应商配置不存在。'], credential: 'missing' };
  const issues: string[] = [];
  if (patch.version !== 1) issues.push('不支持的配置补丁版本。');
  if (patch.baseRevision !== fingerprint(provider)) issues.push('配置在预览后已变化，需要重新生成补丁。');
  if (patch.changes.baseUrl !== undefined) {
    try { const url = new URL(patch.changes.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) issues.push('baseUrl 仅支持 http/https。'); } catch { issues.push('baseUrl 不是有效 URL。'); }
  }
  if (patch.changes.endpointPath !== undefined && !patch.changes.endpointPath.startsWith('/')) issues.push('endpointPath 必须以 / 开头。');
  if (patch.changes.modelId !== undefined && !provider.models.includes(patch.changes.modelId)) issues.push('modelId 不在该供应商的模型列表中。');
  const diff: AgentConfigPatchPreview['diff'] = [];
  if (patch.changes.baseUrl !== undefined && patch.changes.baseUrl !== provider.baseUrl) diff.push({ field: 'baseUrl', before: provider.baseUrl, after: patch.changes.baseUrl });
  if (patch.changes.endpointPath !== undefined && patch.changes.endpointPath !== provider.endpointPath) diff.push({ field: 'endpointPath', before: provider.endpointPath ?? '', after: patch.changes.endpointPath });
  if (patch.changes.apiStyle !== undefined && patch.changes.apiStyle !== provider.apiStyle) diff.push({ field: 'apiStyle', before: provider.apiStyle, after: patch.changes.apiStyle });
  if (patch.changes.modelId && patch.changes.modelMetadata) diff.push({ field: `modelMetadata.${patch.changes.modelId}`, before: redactSensitiveValue(provider.modelMetadata?.[patch.changes.modelId] ?? {}), after: redactSensitiveValue(normalizedMetadata(patch.changes.modelMetadata)) });
  if (!diff.length) issues.push('补丁没有产生任何变化。');
  return { ok: issues.length === 0, providerId: provider.id, baseRevision: fingerprint(provider), diff, issues, credential: provider.apiKey.trim() ? 'configured' : 'missing' };
}

export function applyAgentProviderPatch(
  patch: AgentProviderPatchV1,
  rollbackStore: PersistentAgentConfigRollbackStore = agentConfigRollbackStore,
): { ok: true; rollbackToken: string; revision: string; diff: AgentConfigPatchPreview['diff'] } | { ok: false; issues: string[] } {
  const preview = previewAgentProviderPatch(patch);
  if (!preview.ok) return { ok: false, issues: preview.issues };
  const provider = useCustomProvidersStore.getState().providers.find((item) => item.id === patch.providerId)!;
  const rollbackToken = globalThis.crypto?.randomUUID?.() ?? `config-rollback-${Date.now().toString(36)}`;
  const previous: AgentConfigRollbackSnapshot['previous'] = {
    ...(patch.changes.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(patch.changes.endpointPath === undefined ? {} : { endpointPath: provider.endpointPath ?? null }),
    ...(patch.changes.apiStyle === undefined ? {} : { apiStyle: provider.apiStyle }),
    ...(patch.changes.modelId && patch.changes.modelMetadata
      ? { modelMetadata: provider.modelMetadata ? structuredClone(provider.modelMetadata) : null }
      : {}),
  };
  const modelMetadata = patch.changes.modelId && patch.changes.modelMetadata
    ? { ...(provider.modelMetadata ?? {}), [patch.changes.modelId]: normalizedMetadata(patch.changes.modelMetadata) ?? {} }
    : provider.modelMetadata;
  const changes: Partial<CustomProviderConfig> = {
    ...(patch.changes.baseUrl === undefined ? {} : { baseUrl: patch.changes.baseUrl }),
    ...(patch.changes.endpointPath === undefined ? {} : { endpointPath: patch.changes.endpointPath }),
    ...(patch.changes.apiStyle === undefined ? {} : { apiStyle: patch.changes.apiStyle }),
    modelMetadata,
  };
  const revision = fingerprint({ ...provider, ...changes });
  rollbackStore.put({ token: rollbackToken, providerId: provider.id, appliedRevision: revision, previous, createdAt: Date.now() });
  try {
    useCustomProvidersStore.getState().updateProvider(provider.id, changes);
  } catch (error) {
    rollbackStore.delete(rollbackToken);
    throw error;
  }
  return { ok: true, rollbackToken, revision, diff: preview.diff };
}

export function rollbackAgentProviderPatch(
  rollbackToken: string,
  rollbackStore: PersistentAgentConfigRollbackStore = agentConfigRollbackStore,
): { ok: boolean; providerId?: string; error?: string } {
  const snapshot = rollbackStore.get(rollbackToken);
  if (!snapshot) return { ok: false, error: '回滚快照不存在或已过期。' };
  if (snapshot.providerId === GENERATION_NETWORK_CONFIG_ID) {
    if (getAgentGenerationNetworkRevision() !== snapshot.appliedRevision) {
      return { ok: false, providerId: snapshot.providerId, error: '配置在应用后已变化，不能覆盖当前值；请重新预览回滚。' };
    }
    const route = snapshot.previous.generationNetworkRoute;
    if (!route) return { ok: false, providerId: snapshot.providerId, error: '回滚快照缺少网络路线。' };
    const network = useSettingsStore.getState().generationNetworkSettings;
    useSettingsStore.getState().setGenerationNetworkSettings({ ...network, route });
    rollbackStore.delete(rollbackToken);
    return { ok: true, providerId: snapshot.providerId };
  }
  if (getAgentProviderRevision(snapshot.providerId) !== snapshot.appliedRevision) {
    return { ok: false, providerId: snapshot.providerId, error: '配置在应用后已变化，不能覆盖当前值；请重新预览回滚。' };
  }
  const restored: Partial<CustomProviderConfig> = {};
  if (Object.prototype.hasOwnProperty.call(snapshot.previous, 'baseUrl')) restored.baseUrl = snapshot.previous.baseUrl;
  if (Object.prototype.hasOwnProperty.call(snapshot.previous, 'endpointPath')) restored.endpointPath = snapshot.previous.endpointPath ?? undefined;
  if (Object.prototype.hasOwnProperty.call(snapshot.previous, 'apiStyle')) restored.apiStyle = snapshot.previous.apiStyle;
  if (Object.prototype.hasOwnProperty.call(snapshot.previous, 'modelMetadata')) restored.modelMetadata = snapshot.previous.modelMetadata ?? undefined;
  useCustomProvidersStore.getState().updateProvider(snapshot.providerId, restored);
  rollbackStore.delete(rollbackToken);
  return { ok: true, providerId: snapshot.providerId };
}
