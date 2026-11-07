import type { CustomProviderChatModelMetadata } from '@/stores/customProvidersStore';
import { credentialConfigured, getChannelCredential, getChannelCredentialRef, channelProviderId, saveChannelRecord, useChannelStore } from '@/features/channels/store/channelStore';
import { channelProfileSchema, operationKinds, validateProfile, type ChannelProfileV2, type OperationKind } from '@/features/channels/domain/profile';
import { useSettingsStore, type GenerationNetworkRoute } from '@/stores/settingsStore';
import { redactSensitiveValue } from './agentRedaction';
import { credentialAppearsIn } from '@/features/secrets/secretStore';

const CONFIG_ROLLBACK_STORAGE_KEY = 'storyboard-copilot:canvas-agent:config-rollbacks:v1';
const MAX_CONFIG_ROLLBACKS = 200;
const GENERATION_NETWORK_CONFIG_ID = '__application_generation_network__';

export interface AgentProviderPatchV1 {
  version: 1;
  providerId: string;
  baseRevision: string;
  changes: {
    baseUrl?: string;
    /** Maps to the uniquely identified operation path, never a legacy projection. */
    endpointPath?: string;
    /** Accepted only to return an explicit unrepresentable-field validation error. */
    apiStyle?: string;
    modelId?: string;
    /** Only description maps to ModelSpec.label; capability fields fail validation. */
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
    operationPaths?: Partial<Record<OperationKind, string>>;
    /** null records a label that was absent, including across JSON persistence. */
    modelLabels?: Record<string, string | null>;
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
  const allowed: Record<string, true> = { baseUrl: true, operationPaths: true, modelLabels: true, generationNetworkRoute: true };
  if (Object.keys(value.previous).some((key) => !Object.prototype.hasOwnProperty.call(allowed, key))) return false;
  if (value.previous.baseUrl !== undefined && typeof value.previous.baseUrl !== 'string') return false;
  if (value.previous.operationPaths !== undefined && (!isPlainRecord(value.previous.operationPaths)
    || Object.entries(value.previous.operationPaths).some(([key, path]) => !operationKinds.includes(key as OperationKind) || typeof path !== 'string'))) return false;
  if (value.previous.modelLabels !== undefined && (!isPlainRecord(value.previous.modelLabels)
    || Object.values(value.previous.modelLabels).some((label) => label !== null && typeof label !== 'string'))) return false;
  if (
    value.previous.generationNetworkRoute !== undefined
    && !['system', 'direct', 'custom-proxy'].includes(value.previous.generationNetworkRoute as string)
  ) return false;
  return true;
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

function resolveProvider(providerId: string) {
  const records = useChannelStore.getState().channels.filter((entry) => entry.origin === 'native');
  const direct = records.find((entry) => entry.profile.id === providerId);
  if (direct) return { profile: direct.profile, mediaType: undefined };
  for (const { profile } of records) {
    for (const mediaType of ['image', 'video', 'chat'] as const) {
      if (channelProviderId(profile.id, mediaType) === providerId && profile.models.some((model) => model.operations.some((kind) =>
        mediaType === 'chat' ? kind === 'chat' : kind.startsWith(`${mediaType}.`)))) return { profile, mediaType };
    }
  }
  return undefined;
}

function fingerprint(profile: ChannelProfileV2): string {
  // Display-only channel edits and independent credential changes must survive rollback.
  const value = JSON.stringify({ id: profile.id, baseUrl: profile.baseUrl, auth: profile.auth,
    headers: profile.headers, operations: profile.operations, models: profile.models });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `channel-v2-${(hash >>> 0).toString(16)}`;
}

export function getAgentProviderRevision(providerId: string): string | null {
  const resolved = resolveProvider(providerId);
  return resolved ? fingerprint(resolved.profile) : null;
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

function prepareProviderPatch(patch: AgentProviderPatchV1): {
  preview: AgentConfigPatchPreview;
  next?: ChannelProfileV2;
  previous: AgentConfigRollbackSnapshot['previous'];
} {
  const resolved = resolveProvider(patch.providerId);
  if (!resolved) return {
    preview: { ok: false, providerId: patch.providerId, baseRevision: patch.baseRevision, diff: [],
      issues: ['原生渠道配置不存在；特殊适配器不能通过 HTTP 配置补丁修改。'], credential: 'missing' },
    previous: {},
  };
  const { profile, mediaType } = resolved;
  const issues: string[] = [];
  const diff: AgentConfigPatchPreview['diff'] = [];
  const previous: AgentConfigRollbackSnapshot['previous'] = {};
  const next = structuredClone(profile);
  const changes = patch.changes;
  const allowed: Record<string, true> = { baseUrl: true, endpointPath: true, apiStyle: true, modelId: true, modelMetadata: true };
  if (!isPlainRecord(changes)) issues.push('changes 必须是配置字段对象。');
  else {
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined && !Object.prototype.hasOwnProperty.call(allowed, key)) issues.push(`不允许修改配置字段：${key}。`);
    }
    if (changes.baseUrl !== undefined) {
      next.baseUrl = changes.baseUrl;
      if (changes.baseUrl !== profile.baseUrl) {
        previous.baseUrl = profile.baseUrl;
        diff.push({ field: 'baseUrl', before: profile.baseUrl, after: changes.baseUrl });
      }
    }
    if (changes.endpointPath !== undefined) {
      const candidates = operationKinds.filter((kind) => kind !== 'models.list' && profile.operations[kind]
        && (!mediaType || (mediaType === 'chat' ? kind === 'chat' : kind.startsWith(`${mediaType}.`))));
      if (typeof changes.endpointPath !== 'string' || !changes.endpointPath.startsWith('/') || changes.endpointPath.startsWith('//')) {
        issues.push('endpointPath 必须是以单个 / 开头的操作路径。');
      }
      if (candidates.length !== 1) issues.push('endpointPath 无法唯一对应渠道操作；请在渠道配置中明确修改操作路径。');
      else {
        const kind = candidates[0];
        const operation = next.operations[kind]!;
        if (operation.path !== changes.endpointPath) {
          previous.operationPaths = { [kind]: operation.path };
          diff.push({ field: `operations.${kind}.path`, before: operation.path, after: changes.endpointPath });
          operation.path = changes.endpointPath;
        }
      }
    }
    if (changes.apiStyle !== undefined) issues.push('apiStyle 无法表示为渠道字段；协议由 operations 模板声明，不能修改旧投影。');
    const model = next.models.find((entry) => entry.id === changes.modelId);
    if (changes.modelId !== undefined && !model) issues.push('modelId 不在该渠道的模型列表中。');
    if (changes.modelMetadata !== undefined) {
      if (!changes.modelId) issues.push('modelMetadata 必须指定 modelId。');
      if (!isPlainRecord(changes.modelMetadata)) issues.push('modelMetadata 必须是模型字段对象。');
      else {
        for (const [key, value] of Object.entries(changes.modelMetadata)) {
          if (value !== undefined && key !== 'description') issues.push(`modelMetadata.${key} 无法表示为渠道模型字段；能力由渠道操作和参数声明，不能修改旧投影。`);
        }
        // Channel projections expose ModelSpec.label as their legacy description.
        const description = changes.modelMetadata.description;
        if (description !== undefined && description !== null && typeof description !== 'string') {
          issues.push('modelMetadata.description 必须是字符串或 null。');
        } else if (model && description !== undefined && (description ?? undefined) !== model.label) {
          previous.modelLabels = { [model.id]: model.label ?? null };
          diff.push({ field: `models.${model.id}.label`, before: model.label ?? null, after: description });
          if (description === null) delete model.label;
          else model.label = description;
        }
      }
    }
  }
  if (patch.version !== 1) issues.push('不支持的配置补丁版本。');
  if (patch.baseRevision !== fingerprint(profile)) issues.push('配置在预览后已变化，需要重新生成补丁。');
  issues.push(...validateProfile(next).map((issue) => `${issue.path}: ${issue.message}`));
  const credential = getChannelCredential(profile.id);
  if (credentialAppearsIn(getChannelCredentialRef(profile.id), JSON.stringify(next))
    || (credential && JSON.stringify(next).includes(JSON.stringify(credential).slice(1, -1)))) issues.push('渠道配置不能包含独立 API Key 凭据。');
  if (!diff.length) issues.push('补丁没有产生任何变化。');
  return {
    preview: { ok: issues.length === 0, providerId: profile.id, baseRevision: fingerprint(profile),
      diff: issues.length ? [] : diff.map((entry) => ({ ...entry, before: redactSensitiveValue(entry.before), after: redactSensitiveValue(entry.after) })),
      issues, credential: credentialConfigured(profile.id) ? 'configured' : 'missing' },
    next: issues.length ? undefined : channelProfileSchema.parse(next),
    previous,
  };
}

export function previewAgentProviderPatch(patch: AgentProviderPatchV1): AgentConfigPatchPreview {
  return prepareProviderPatch(patch).preview;
}

export function applyAgentProviderPatch(
  patch: AgentProviderPatchV1,
  rollbackStore: PersistentAgentConfigRollbackStore = agentConfigRollbackStore,
): { ok: true; rollbackToken: string; revision: string; diff: AgentConfigPatchPreview['diff'] } | { ok: false; issues: string[] } {
  const { preview, next, previous } = prepareProviderPatch(patch);
  if (!preview.ok || !next) return { ok: false, issues: preview.issues };
  const rollbackToken = globalThis.crypto?.randomUUID?.() ?? `config-rollback-${Date.now().toString(36)}`;
  const revision = fingerprint(next);
  rollbackStore.put({ token: rollbackToken, providerId: next.id, appliedRevision: revision, previous, createdAt: Date.now() });
  // The durable checkpoint precedes mutation, and cannot authorize overwriting a concurrent edit.
  if (getAgentProviderRevision(next.id) !== preview.baseRevision) {
    rollbackStore.delete(rollbackToken);
    return { ok: false, issues: ['配置在预览后已变化，需要重新生成补丁。'] };
  }
  const previousRecord = useChannelStore.getState().channels.find((entry) => entry.profile.id === next.id)!;
  try {
    saveChannelRecord({ ...previousRecord.profile, baseUrl: next.baseUrl, operations: next.operations, models: next.models });
  } catch (error) {
    // A persistence listener may throw after Zustand has already changed the in-memory record.
    useChannelStore.setState((state) => ({ channels: state.channels.map((entry) => entry.profile.id === next.id ? previousRecord : entry) }));
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
  const profile = resolveProvider(snapshot.providerId)!.profile;
  const restored = structuredClone(profile);
  if (snapshot.previous.baseUrl !== undefined) restored.baseUrl = snapshot.previous.baseUrl;
  for (const kind of operationKinds) {
    const path = snapshot.previous.operationPaths?.[kind];
    if (path !== undefined && restored.operations[kind]) restored.operations[kind]!.path = path;
  }
  for (const [id, label] of Object.entries(snapshot.previous.modelLabels ?? {})) {
    const model = restored.models.find((entry) => entry.id === id);
    if (!model) return { ok: false, providerId: snapshot.providerId, error: '回滚快照的模型不存在。' };
    if (label === null) delete model.label;
    else model.label = label;
  }
  const issues = validateProfile(restored);
  if (issues.length) return { ok: false, providerId: snapshot.providerId, error: '回滚后的渠道配置无效。' };
  saveChannelRecord(restored);
  rollbackStore.delete(rollbackToken);
  return { ok: true, providerId: snapshot.providerId };
}
