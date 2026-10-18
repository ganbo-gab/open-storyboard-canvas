import { tauriAiGateway } from '@/features/canvas/infrastructure/tauriAiGateway';
import { submitCustomChatCompletion, recoverCustomProviderJob } from '@/features/canvas/infrastructure/customProviderGateway';
import { generateAudio } from '@/features/canvas/infrastructure/localAudioGateway';
import { useSettingsStore } from '@/stores/settingsStore';
import type { GenerationJobPollStatus } from '@/features/canvas/application/ports';
import type { WorkbenchMessage, WorkbenchResult, WorkbenchSubmitInput, WorkbenchTask } from '../domain/types';
import { getAssetPortableSource } from '@/features/assets/application/assetMediaStorage';

export interface WorkbenchTransport {
  submit(input: WorkbenchSubmitInput, history: WorkbenchMessage[]): Promise<{ jobId?: string; results?: WorkbenchResult[] }>;
  poll(task: WorkbenchTask): Promise<GenerationJobPollStatus>;
  recover(task: WorkbenchTask): Promise<void>;
}
export const workbenchTransport: WorkbenchTransport = {
  async submit(input, history) {
    const refs = await Promise.all((input.references ?? []).map(async (reference) => ({ ...reference, source: await getAssetPortableSource(reference.source) })));
    const config = input.config ?? {};
    const prompt = [input.prompt, ...refs.filter((ref) => ref.kind === 'text').map((ref) => ref.source)].join('\n\n');
    if (input.kind === 'chat') {
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
      for (const ref of refs) {
        if (ref.kind === 'image') content.push({ type: 'image_url', image_url: { url: ref.source } });
        else if (ref.kind === 'text') content.push({ type: 'text', text: ref.source });
        else throw new Error('文本对话暂不支持视频或音频引用，请选择图片或文本');
      }
      const response = await submitCustomChatCompletion(input.model, {
        ...config.extraParams,
        model: input.model,
        messages: [...history.map((item) => ({ role: item.role, content: item.text })), { role: 'user', content }],
      });
      return { results: [{ kind: 'text', source: response.text }] };
    }
    if (input.kind === 'audio') {
      if (refs.some((ref) => ref.kind === 'image' || ref.kind === 'video') || refs.filter((ref) => ref.kind === 'audio').length > 1) throw new Error('音频生成仅支持一个音频参考和文本参考');
      const settings = useSettingsStore.getState().audioGenerationSettings;
      const model = settings.models.find((item) => item.id === input.model && item.enabled);
      if (!model) throw new Error('未找到已启用的音频模型配置');
      const audio = refs.find((ref) => ref.kind === 'audio');
      const response = await generateAudio({ model, text: prompt,
        fallbackBaseUrl: settings.apiBaseUrl, voiceId: typeof config.extraParams?.voiceId === 'string' ? config.extraParams.voiceId : model.defaultVoiceId || settings.selectedVoiceId,
        outputMode: model.outputMode, timeoutMs: model.timeoutMs,
        referenceAudioUrl: audio?.source, referenceAudioTitle: audio?.name, extraParams: config.extraParams });
      return { results: [{ kind: 'audio', source: response.audioUrl }] };
    }
    if (input.kind === 'image') {
      if (refs.some((ref) => ref.kind === 'video' || ref.kind === 'audio')) throw new Error('图片生成不支持视频或音频引用');
      if (!/^(custom:|agnes:|dreamina:|comfyui:)/.test(input.model)) {
        for (const [provider, key] of Object.entries(useSettingsStore.getState().apiKeys)) {
          if (key?.trim()) await tauriAiGateway.setApiKey(provider, key);
        }
      }
      const jobId = await tauriAiGateway.submitGenerateImageJob({ prompt, model: input.model,
        size: config.size ?? '1K', aspectRatio: config.aspectRatio ?? 'auto',
        referenceImages: refs.filter((ref) => ref.kind === 'image').map((ref) => ref.source), extraParams: config.extraParams });
      return { jobId };
    }
    const jobId = await tauriAiGateway.submitGenerateVideoJob({ prompt, model: input.model,
      size: config.size ?? '720p', aspectRatio: config.aspectRatio ?? 'auto', seconds: config.seconds,
      referenceImages: refs.filter((ref) => ref.kind === 'image').map((ref) => ref.source),
      referenceVideos: refs.filter((ref) => ref.kind === 'video').map((ref) => ref.source),
      referenceAudios: refs.filter((ref) => ref.kind === 'audio').map((ref) => ref.source), extraParams: config.extraParams });
    return { jobId };
  },
  async poll(task) {
    if (!task.jobId) throw new Error('没有上游任务编号；不会重新提交生成请求');
    return task.input.kind === 'video' ? await tauriAiGateway.getGenerateVideoJob(task.jobId) : await tauriAiGateway.getGenerateImageJob(task.jobId);
  },
  async recover(task) {
    if (!task.jobId) throw new Error('没有可恢复的任务编号；不会重新提交生成请求');
    if (task.jobId.startsWith('custom-local-')) {
      await recoverCustomProviderJob(task.jobId);
    } else if (task.jobId.startsWith('dreamina-')) {
      const retry = task.input.kind === 'video' ? tauriAiGateway.retryGenerateVideoJob : tauriAiGateway.retryGenerationJob;
      if (!await retry?.(task.jobId)) throw new Error('当前任务没有可安全取回的结果；不会重新提交');
    }
    // Built-in native jobs are queried only. No POST is issued by this path.
  },
};
