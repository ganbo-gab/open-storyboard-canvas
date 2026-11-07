import { useCanvasStore } from '@/stores/canvasStore';
import { t } from 'i18next';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { buildChannelAudioModelCatalog, type ChannelAudioModelEntry } from '@/features/channels/application/audioModelCatalog';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { normalizeChannelGenerationFields } from '@/features/channels/application/generationFields';
import { modeParamDefaults, resolveModelMode } from '@/features/channels/application/modelModes';
import { channelJobFromRequest, getChannelJobAsync, submitChannelJob } from '@/features/channels/runtime/channelExecution';
import { channelRequestOptions } from '@/features/channels/runtime/requestReferences';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import type { JobInput } from '@/features/channels/runtime/types';
import { CANVAS_NODE_TYPES, type AiAudioNodeData } from '../../domain/canvasNodes';
import { collectInputReferences } from '../graphReferenceResolver';
import { publishGenerationJobResults } from './publishJobResults';
import { GenerationInputError } from './types';
import { generationCanvasMutations } from './canvasMutations';

export interface ChannelAudioRequestAssembly {
  kind: 'channel';
  text: string;
  latestModel: ChannelAudioModelEntry;
  latestGenerationParams: Record<string, unknown>;
  profile: ChannelProfileV2;
  input: JobInput;
}

/** Native audio is selected by the same catalog ID as workbench, not a local audio settings record. */
export function assembleChannelAudioRequest(id: string, text: string): ChannelAudioRequestAssembly {
  const state = useCanvasStore.getState();
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (!node || node.type !== CANVAS_NODE_TYPES.aiAudio) throw new GenerationInputError('unsupported', 'Audio generator does not exist');
  const data = node.data as AiAudioNodeData;
  const catalog = buildChannelAudioModelCatalog(useChannelStore.getState().channels);
  const fallback = !data.modelId ? catalog.find((entry) => entry.usable)?.id : undefined;
  const native = resolveNativeChannelModel(data.modelId || fallback || '');
  if (!native) throw new GenerationInputError('missing-model', t(data.modelId ? 'node.aiAudio.unavailableModel' : 'node.aiAudio.noModel'));
  const entry = catalog.find((candidate) => candidate.channelModelRef.profileId === native.profile.id && candidate.modelId === native.model.id);
  if (!entry) throw new GenerationInputError('missing-model', '所选渠道模型不支持音频生成');
  if (!entry.usable) throw new GenerationInputError('missing-credentials', entry.notReadyReason || '渠道未配置 API Key');
  const fields = normalizeChannelGenerationFields(data);
  const mode = resolveModelMode(native.model, fields.channelModeId ?? entry.modes[0]?.mode.id);
  if (native.model.modes && mode.operation !== 'audio.generate') throw new GenerationInputError('invalid-input', '所选模式不支持音频生成');
  const params = { ...modeParamDefaults(mode), ...data.audioGenerationParams };
  const references = collectInputReferences(id, state.nodes, state.edges);
  const request = { model: entry.id, prompt: text, size: '', aspect_ratio: '', channel_mode_id: native.model.modes ? mode.mode.id : undefined,
    reference_slots: fields.referenceSlots, extra_params: params,
    reference_images: references.flatMap((reference) => reference.kind === 'image' && reference.imageUrl ? [reference.imageUrl] : []),
    reference_videos: references.flatMap((reference) => reference.kind === 'video' && reference.videoUrl ? [reference.videoUrl] : []),
    reference_audios: references.flatMap((reference) => reference.kind === 'audio' && reference.audioUrl ? [reference.audioUrl] : []) };
  const input = channelJobFromRequest(native.profile, native.model.id, request, 'audio', channelRequestOptions(native.profile, native.model.id, request));
  return { kind: 'channel', text, latestModel: entry, latestGenerationParams: params, profile: native.profile, input };
}

/** One shared durable submit; polling and explicit recovery never recreate an accepted audio job. */
export async function executeChannelAudioRequest(id: string, assembled: ChannelAudioRequestAssembly, resultNodeIds: string[], jobIds: string[], agentTurnId?: string): Promise<void> {
  const state = useCanvasStore.getState();
  const mutations = generationCanvasMutations(agentTurnId);
  const startedAt = Date.now();
  const resultId = mutations.addNode(CANVAS_NODE_TYPES.audio, state.findNodePosition(id, 360, 160), {
    isGenerating: true, generationStartedAt: startedAt, sourcePrompt: assembled.text, sourceModelId: assembled.latestModel.id,
  });
  mutations.addEdge(id, resultId, { provenance: 'generationResult' });
  resultNodeIds.push(resultId);
  const jobId = await submitChannelJob(assembled.profile, assembled.input);
  jobIds.push(jobId);
  mutations.updateNodeData(resultId, { generationJobId: jobId, generationLastJobId: jobId, generationProviderId: assembled.profile.id });
  for (;;) {
    const current = useCanvasStore.getState().nodes.find((node) => node.id === resultId);
    if (!current || current.data.isGenerating === false) return;
    const job = await getChannelJobAsync(jobId);
    if (job.status === 'succeeded') {
      for (const outputId of publishGenerationJobResults(resultId, job)) if (!resultNodeIds.includes(outputId)) resultNodeIds.push(outputId);
      return;
    }
    if (['failed', 'unknown', 'recoverable_wait', 'canceled', 'not_found'].includes(job.status)) throw new Error(job.error || '音频生成结果尚未确认；保留原任务编号，不会自动重新提交');
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
  }
}
