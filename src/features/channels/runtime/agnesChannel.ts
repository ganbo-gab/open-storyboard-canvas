import { AGNES_PROVIDER_DEFAULTS, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore, type GenerationNetworkSettings } from '@/stores/settingsStore';
import { migrateLegacyConfig } from '../migrate/legacyConfig';
import { channelStoresHydrated, ensureChannelStoresHydrated, getChannelCredential, saveChannelRecord, setChannelCredential, useChannelStore } from '../store/channelStore';
import { TemplateAdapter } from './templateAdapter';
import { createChannelHttpTransport, resolveChannelRef } from './transport';

function agnesConfig(media: 'image' | 'video' | 'chat'): CustomProviderConfig {
  const defaults = AGNES_PROVIDER_DEFAULTS;
  return { id: `settings-agnes-${media}`, label: `Agnes ${media}`, mediaType: media,
    baseUrl: defaults.baseUrl, endpointPath: media === 'chat' ? defaults.chatEndpointPath : media === 'video' ? defaults.videoEndpointPath : defaults.imageEndpointPath,
    modelListEndpointPath: defaults.modelListEndpointPath, apiKey: '', apiStyle: 'openai-compatible', supportsWebSearch: false,
    models: media === 'chat' ? [defaults.models.chat25Flash, defaults.models.chat20Flash, defaults.models.chat15Flash]
      : media === 'video' ? [defaults.models.video20] : [defaults.models.image21Flash, defaults.models.image20Flash],
    responseFormat: media === 'image' ? 'openai-images' : 'generic',
    supportedResolutions: media === 'image' ? [...defaults.imageResolutions] : media === 'video' ? [...defaults.videoResolutions] : undefined,
    extraParams: { providerKind: media === 'chat' ? 'agnes-chat' : media === 'video' ? 'agnes-video' : 'agnes-images',
      ...(media === 'video' ? { videoRequestBodyMode: 'json', supportedDurations: Array.from({ length: 18 }, (_, index) => String(index + 1)),
        supportedRatios: ['16:9', '9:16', '1:1'], videoTaskIdPath: 'task_id', videoStatusEndpointPath: defaults.videoStatusEndpointPath,
        responseVideoPath: 'video_url', videoStatusPath: 'status', videoSuccessValues: ['completed'], videoFailedValues: ['failed'], videoReferenceField: 'image',
        defaultRequestParams: { frame_rate: 24, negative_prompt: '' } } : {}),
    } };
}
/** One-time settings credential migration; subsequent edits live in channels, not the legacy executor. */
export function migrateAgnesSettingsCredential(key: string, replaceCredential = false): void {
  // Settings hydration can finish before channel credentials, so startup migration
  // must never write an incomplete channel list over durable records. Keep the
  // public API synchronous for already-hydrated callers and defer only the cold path.
  if (!channelStoresHydrated()) {
    void ensureChannelStoresHydrated().then(() => migrateAgnesSettingsCredential(key, replaceCredential)).catch(() => undefined);
    return;
  }
  for (const media of ['image', 'video', 'chat'] as const) {
    const config = agnesConfig(media);
    const previous = useChannelStore.getState().channels.find((entry) => entry.profile.id === config.id);
    if (!previous && key.trim()) {
      const profile = migrateLegacyConfig(config).profile;
      if (media === 'image') for (const model of profile.models) {
        const resolutions = model.id === AGNES_PROVIDER_DEFAULTS.models.image20Flash
          ? AGNES_PROVIDER_DEFAULTS.image20Resolutions : AGNES_PROVIDER_DEFAULTS.image21Resolutions;
        const size = model.params.find((param) => param.key === 'size');
        if (size) { size.type = 'enum'; size.options = resolutions.map((value) => ({ label: value, value })); size.default = resolutions[0]; }
      }
      if (media === 'video') {
        const sizes = [{ width: 1280, height: 720 }, { width: 720, height: 1280 }, { width: 1024, height: 1024 },
          { width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1536, height: 1536 }];
        profile.operations['video.generate'] = { method: 'POST', path: '/v1/videos', body: 'json',
          template: { model: '{{model}}', prompt: '{{prompt}}', width: '{{param.size.width}}', height: '{{param.size.height}}',
            num_frames: '{{param.seconds.frames}}', frame_rate: 24 },
          response: { mode: 'async', taskIdPath: 'task_id', poll: { method: 'GET', path: '/v1/videos/{{taskId}}', intervalSec: 2, timeoutMin: 15,
            statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'video_url', as: 'url', kind: 'video' }] } } };
        profile.models = [{ id: AGNES_PROVIDER_DEFAULTS.models.video20, operations: ['video.generate'], params: [
          { key: 'size', label: '尺寸与比例', type: 'enum', options: sizes.map((value) => ({ label: `${value.width}x${value.height}`, value })), default: sizes[0] },
          { key: 'seconds', label: '时长（秒）', type: 'enum', options: Array.from({ length: 18 }, (_, index) => {
            const seconds = index + 1;
            return { label: String(seconds), value: { seconds, frames: seconds >= 17.75 ? 441 : Math.min(441, Math.round((seconds * 24 - 1) / 8) * 8 + 1) } };
          }), default: { seconds: 5, frames: 121 } },
        ], refs: { image: 0 } }];
        profile.notes = [...(profile.notes ?? []), '旧 Agnes 的 1k/2k 与比例组合已改为明确像素选项；多图、首尾帧及运行时 frame_rate 覆盖不能由本静态模板无损迁移，未声明为可用能力。'];
      }
      const record = saveChannelRecord(profile);
      if (media === 'video') useChannelStore.setState((state) => ({ channels: state.channels.map((entry) => entry === record ? { ...entry, migrationIssues: [
        { key: 'supportedResolutions', value: config.supportedResolutions, reason: '1k/2k 与比例组合改为明确像素选项，请重新选择尺寸。', kind: 'converted' },
        { key: 'referenceImages', value: 'single/multi/keyframes', reason: '旧模式条件及多图引用不能由此静态模板无损迁移，已禁用引用而非发送猜测格式。', kind: 'unsupported' },
        { key: 'frame_rate', value: 'runtime override', reason: '帧数与帧率组合仅保留固定 24fps 的声明映射。', kind: 'unsupported' },
      ] } : entry) }));
    }
    if ((previous || key.trim()) && (replaceCredential || !getChannelCredential(config.id))) void setChannelCredential(config.id, key.trim()).catch(() => undefined);
  }
}

let agnesSyncStarted = false;

/**
 * Keeps the Agnes key entered in settings in step with its channels. Called once at app start;
 * never as an import side effect (that ran mid-initialization and broke the module graph).
 */
export function startAgnesCredentialSync(): void {
  if (agnesSyncStarted) return;
  agnesSyncStarted = true;
  migrateAgnesSettingsCredential(useSettingsStore.getState().agnesApiKey);
  useSettingsStore.subscribe((state, previous) => {
    if (state.agnesApiKey !== previous.agnesApiKey) migrateAgnesSettingsCredential(state.agnesApiKey, previous.isHydrated);
  });
}

export interface AgnesKeyVerificationResult {
  ok: boolean; status?: number; modelCount?: number;
  category?: 'authentication' | 'authorization' | 'rate-limit' | 'network' | 'response-shape'; errorMessage?: string;
}
export async function verifyAgnesKey(apiKey: string, network: Readonly<GenerationNetworkSettings> = useSettingsStore.getState().generationNetworkSettings): Promise<AgnesKeyVerificationResult> {
  if (!apiKey.trim()) return { ok: false, category: 'authentication', errorMessage: '请先输入 Agnes Key。' };
  const profile = migrateLegacyConfig(agnesConfig('chat')).profile;
  const result = await new TemplateAdapter({ profile, apiKey: apiKey.trim(), http: createChannelHttpTransport(network), resolveRef: resolveChannelRef }).listModels();
  if (result.ok) return result.models.length ? { ok: true, modelCount: result.models.length } : { ok: false, category: 'response-shape', errorMessage: 'Agnes 已响应，但模型列表格式无法识别。' };
  const status = result.error.status;
  return { ok: false, status, category: status === 401 ? 'authentication' : status === 403 ? 'authorization' : status === 429 ? 'rate-limit' : 'network', errorMessage: result.error.message };
}
