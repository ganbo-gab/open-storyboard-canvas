import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import type { GenerateRequest, GenerationJobStatus } from '@/commands/ai';
import { loadAudioSourceDataUrl, persistVideoSource } from '@/commands/image';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  parseDreaminaTransitionSegments,
  parseDreaminaVideoEntryId,
  validateDreaminaImageRequest,
  validateDreaminaVideoRequest,
  type DreaminaImageCommand,
} from '../application/dreaminaCapabilities';
import type { GenerateVideoPayload } from '../application/ports';

interface DreaminaBackendResult {
  ok: boolean;
  submitId?: string | null;
  genStatus?: string | null;
  failReason?: string | null;
  complianceRequired?: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  error?: string | null;
}

const resultCache = new Map<string, GenerationJobStatus>();

function createJobId(kind: 'image' | 'video'): string {
  return `dreamina-${kind}-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setFailedJob(jobId: string, error: string): string {
  resultCache.set(jobId, {
    job_id: jobId,
    status: 'failed',
    result: null,
    error,
  });
  return jobId;
}

function defaultSessionId(): number {
  const value = useSettingsStore.getState().dreaminaDefaultSessionId;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function stashRemoteOrDataUrlToTempFile(src: string): Promise<string> {
  if (!src.startsWith('data:')) return src;
  return await invoke<string>('dreamina_stage_reference_image', { dataUrl: src });
}

function redactDreaminaDiagnostic(value: string): string {
  return value
    .replace(/file:\/\/\/[^\s"'`]+/gi, '[local path]')
    .replace(/\/(?:Users|home|tmp|private|Volumes|var\/folders)\/[^\s"'`,;)]*/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\s"'`,;)]*/g, '[local path]')
    .replace(
      /\b(device[_-]?code|access[_-]?token|refresh[_-]?token|authorization)\b\s*[=:]\s*["']?[^\s"',;}]+/gi,
      '$1=[redacted]',
    )
    .replace(
      /([?&](?:device[_-]?code|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi,
      '$1[redacted]',
    );
}

export function humanizeDreaminaFailReason(reason: string | undefined | null): string {
  if (!reason) return '即梦服务端任务失败，原因未知';
  const lower = reason.toLowerCase();
  if (lower.includes('aigccomplianceconfirmationrequired')) {
    return '即梦要求先完成一次内容生成授权。请打开即梦网页版完成 AIGC 合规确认，然后回到画布重试。';
  }
  if ((lower.includes('eof') || lower.includes('i/o timeout') || lower.includes('do request')) && (
    lower.includes('upload token')
    || lower.includes('image_generate')
    || lower.includes('post ')
    || lower.includes('do request')
    || lower.includes('i/o timeout')
  )) {
    return '即梦提交连接在结果确认前中断。上游可能已经接收并扣费，为避免重复生成，本应用没有自动重试。请先在即梦任务记录中核对，再决定是否重试；也可在设置中运行网络体检。';
  }
  if (lower.includes('context deadline exceeded') || lower.includes('timeout')) {
    return '即梦请求超时，提交结果可能未知。为避免重复扣费，本应用没有自动重试，请先检查即梦任务记录。';
  }
  if (lower.includes('credit') || lower.includes('积分')) {
    return '即梦积分不足或账号限流';
  }
  if (lower.includes('unauthor') || lower.includes('未登录') || lower.includes('token expired')) {
    return '即梦登录已过期，请在设置中重新完成 OAuth 登录';
  }
  if (lower.includes('store unavailable') || lower.includes('backend unavailable')) {
    return '即梦 session 存储暂不可用。账号登录可能仍然有效；请切回默认 session 0 后重试。';
  }
  return `即梦服务端返回失败：${redactDreaminaDiagnostic(reason).slice(0, 240)}`;
}

function extractResultUrl(raw: string, media: 'image' | 'video'): string | null {
  const extension = media === 'video'
    ? '(?:mp4|mov|webm|m4v)'
    : '(?:png|jpg|jpeg|webp)';
  const patterns = [
    media === 'video' ? /"video_url"\s*:\s*"([^"]+)"/ : /"image_url"\s*:\s*"([^"]+)"/,
    media === 'video' ? /"videoUrl"\s*:\s*"([^"]+)"/ : /"imageUrl"\s*:\s*"([^"]+)"/,
    new RegExp(`"url"\\s*:\\s*"(https?:\\/\\/[^"]+\\.${extension}(?:\\?[^"]*)?)"`, 'i'),
    /"local_path"\s*:\s*"([^"]+)"/,
    /"localPath"\s*:\s*"([^"]+)"/,
    media === 'video' ? /video_url[=:]\s*(\S+)/ : /image_url[=:]\s*(\S+)/,
    new RegExp(`downloaded\\s+to\\s+(\\S+\\.${extension})`, 'i'),
    new RegExp(`(https?:\\/\\/\\S+\\.${extension}(?:\\?\\S*)?)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function rewrapLocalPath(url: string): string {
  const looksLocal = url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url);
  if (!looksLocal) return url;
  try {
    return convertFileSrc(url);
  } catch {
    return url;
  }
}

function extractSubmitIdFallback(raw: string): string | null {
  const json = raw.match(/"submit_id"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{7,127})"/i);
  const text = raw.match(/submit_id[=:]\s*([A-Za-z0-9][A-Za-z0-9._-]{7,127})/i);
  return json?.[1] ?? text?.[1] ?? null;
}

function extractGenStatusFallback(raw: string): string | null {
  const match = raw.match(/"gen_status"\s*:\s*"([A-Za-z_]+)"/i)
    ?? raw.match(/gen_status[=:]\s*([A-Za-z_]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function inferExtensionFromDataUrl(dataUrl: string, fallback: string): string {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  const mime = match?.[1]?.toLowerCase() ?? '';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('aac')) return 'aac';
  return fallback;
}

async function stashDataUrlToMediaFile(dataUrl: string, fallbackExtension: string): Promise<string> {
  return await invoke<string>('dreamina_stage_reference_media', {
    dataUrl,
    extension: inferExtensionFromDataUrl(dataUrl, fallbackExtension),
  });
}

async function stageVideoReference(src: string): Promise<string> {
  if (src.startsWith('data:')) return await stashDataUrlToMediaFile(src, 'mp4');
  return await persistVideoSource(src);
}

async function stageAudioReference(src: string): Promise<string> {
  const dataUrl = src.startsWith('data:') ? src : await loadAudioSourceDataUrl(src);
  return await stashDataUrlToMediaFile(dataUrl, 'mp3');
}

function backendFailure(backend: DreaminaBackendResult): string {
  if (backend.complianceRequired) {
    return humanizeDreaminaFailReason('AigcComplianceConfirmationRequired');
  }
  return humanizeDreaminaFailReason(
    backend.failReason ?? backend.error ?? backend.stderr ?? backend.stdout,
  );
}

function acceptedSubmission(backend: DreaminaBackendResult): {
  accepted: boolean;
  submitId: string | null;
  genStatus: string | null;
} {
  const combined = `${backend.stdout}\n${backend.stderr}`;
  const submitId = backend.submitId ?? extractSubmitIdFallback(combined);
  const genStatus = backend.genStatus?.toLowerCase() ?? extractGenStatusFallback(combined);
  return {
    accepted: backend.ok
      && Boolean(submitId)
      && (genStatus === 'querying' || genStatus === 'success'),
    submitId,
    genStatus,
  };
}

async function pollDreaminaResult(
  jobId: string,
  submitId: string,
  media: 'image' | 'video',
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const queried = await invoke<DreaminaBackendResult>('dreamina_query_result', {
      submitId,
      downloadDir: undefined,
    });
    const combined = `${queried.stdout}\n${queried.stderr}`;
    const resultUrl = extractResultUrl(combined, media);
    if (resultUrl) return resultUrl;
    const genStatus = queried.genStatus?.toLowerCase() ?? extractGenStatusFallback(combined);
    if (genStatus === 'querying' || genStatus === 'running' || genStatus === 'pending') {
      continue;
    }
    if (!queried.ok || genStatus === 'fail' || queried.complianceRequired) {
      setFailedJob(jobId, backendFailure(queried));
      return null;
    }
  }
  return null;
}

function capabilityErrorMessage(messages: readonly string[]): string {
  return `即梦参数不符合当前 CLI 契约：${messages.join(' ')}`;
}

function stringExtra(extra: Record<string, unknown>, key: string): string | undefined {
  const value = extra[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberExtra(extra: Record<string, unknown>, key: string): number | undefined {
  const value = extra[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function imageRoute(request: GenerateRequest): {
  command: DreaminaImageCommand;
  model?: string;
} {
  const tail = request.model.startsWith('dreamina:')
    ? request.model.slice('dreamina:'.length)
    : request.model;
  const refs = request.reference_images ?? [];
  if (tail === 'upscale' || tail === 'image_upscale') {
    return { command: 'image_upscale' };
  }
  if (tail === 'text2image' || tail === 'image2image') {
    const extra = request.extra_params ?? {};
    return {
      command: tail,
      model: stringExtra(extra, 'modelVersion') ?? '5.0',
    };
  }
  return {
    command: refs.length > 0 ? 'image2image' : 'text2image',
    model: tail,
  };
}

export async function submitDreaminaJob(request: GenerateRequest): Promise<string> {
  const jobId = createJobId('image');
  resultCache.set(jobId, { job_id: jobId, status: 'running', result: null, error: null });
  const refs = request.reference_images ?? [];
  const extra = request.extra_params ?? {};
  const route = imageRoute(request);
  const resolutionType = stringExtra(extra, 'resolutionType')
    ?? (/^(?:1k|2k|4k|8k)$/i.test(request.size) ? request.size.toLowerCase() : undefined);
  const issues = validateDreaminaImageRequest({
    command: route.command,
    model: route.model,
    resolution: resolutionType,
    ratio: request.aspect_ratio,
    imageCount: refs.length,
    generateCount: numberExtra(extra, 'generateNum'),
  });
  if (issues.length > 0) {
    return setFailedJob(jobId, capabilityErrorMessage(issues.map(({ message }) => message)));
  }

  try {
    const sessionId = defaultSessionId();
    let backend: DreaminaBackendResult;
    if (route.command === 'image2image') {
      const imagePaths = await Promise.all(refs.map(stashRemoteOrDataUrlToTempFile));
      backend = await invoke<DreaminaBackendResult>('dreamina_image2image', {
        prompt: request.prompt,
        imagePaths,
        ratio: request.aspect_ratio === 'auto' ? undefined : request.aspect_ratio,
        resolutionType,
        modelVersion: route.model,
        sessionId,
        pollSeconds: 120,
      });
    } else if (route.command === 'image_upscale') {
      const imagePath = await stashRemoteOrDataUrlToTempFile(refs[0]);
      backend = await invoke<DreaminaBackendResult>('dreamina_image_upscale', {
        imagePath,
        resolutionType: resolutionType ?? '2k',
        sessionId,
        pollSeconds: 120,
      });
    } else {
      backend = await invoke<DreaminaBackendResult>('dreamina_text2image', {
        prompt: request.prompt,
        ratio: request.aspect_ratio === 'auto' ? undefined : request.aspect_ratio,
        resolutionType,
        modelVersion: route.model,
        sessionId,
        pollSeconds: 60,
      });
    }

    const submission = acceptedSubmission(backend);
    if (!submission.accepted || !submission.submitId) {
      return setFailedJob(jobId, backendFailure(backend));
    }
    const combined = `${backend.stdout}\n${backend.stderr}`;
    let resultUrl = extractResultUrl(combined, 'image');
    if (!resultUrl) {
      resultUrl = await pollDreaminaResult(jobId, submission.submitId, 'image', 5 * 60 * 1000);
    }
    if (!resultUrl) {
      const current = resultCache.get(jobId);
      if (current?.status !== 'failed') {
        setFailedJob(jobId, '即梦图片任务超过 5 分钟未返回结果，请使用 submit_id 在即梦任务记录中继续查询。');
      }
      return jobId;
    }
    resultCache.set(jobId, {
      job_id: jobId,
      status: 'succeeded',
      result: rewrapLocalPath(resultUrl),
      error: null,
    });
    return jobId;
  } catch (error) {
    return setFailedJob(
      jobId,
      humanizeDreaminaFailReason(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function getDreaminaJob(jobId: string): GenerationJobStatus {
  return resultCache.get(jobId)
    ?? { job_id: jobId, status: 'not_found', result: null, error: 'job id not found' };
}

export async function submitDreaminaVideoJob(payload: GenerateVideoPayload): Promise<string> {
  const jobId = createJobId('video');
  resultCache.set(jobId, { job_id: jobId, status: 'running', result: null, error: null });
  const parsedEntry = parseDreaminaVideoEntryId(payload.model);
  if (!parsedEntry?.supported) {
    return setFailedJob(
      jobId,
      parsedEntry?.diagnostic ?? '无法识别即梦视频模型，请重新选择当前 CLI 支持的模型。',
    );
  }

  const refs = payload.referenceImages ?? [];
  const referenceVideos = payload.referenceVideos ?? [];
  const referenceAudios = payload.referenceAudios ?? [];
  const extra = payload.extraParams ?? {};
  const duration = typeof payload.seconds === 'number' && Number.isFinite(payload.seconds)
    ? Math.round(payload.seconds)
    : undefined;
  const resolution = payload.size && payload.size !== 'auto'
    ? payload.size
    : stringExtra(extra, 'videoResolution');
  const transitions = parseDreaminaTransitionSegments(
    extra.dreaminaTransitionSegments ?? extra.transitionSegments,
  );
  const issues = validateDreaminaVideoRequest({
    command: parsedEntry.command,
    model: parsedEntry.model,
    resolution,
    duration,
    ratio: payload.aspectRatio,
    imageCount: refs.length,
    videoCount: referenceVideos.length,
    audioCount: referenceAudios.length,
    transitions,
  });
  if (issues.length > 0) {
    return setFailedJob(jobId, capabilityErrorMessage(issues.map(({ message }) => message)));
  }

  try {
    const sessionId = defaultSessionId();
    let backend: DreaminaBackendResult;
    if (parsedEntry.command === 'image2video') {
      const imagePath = await stashRemoteOrDataUrlToTempFile(refs[0]);
      backend = await invoke<DreaminaBackendResult>('dreamina_image2video', {
        prompt: payload.prompt,
        imagePath,
        modelVersion: parsedEntry.model,
        duration,
        videoResolution: resolution,
        sessionId,
        pollSeconds: 180,
      });
    } else if (parsedEntry.command === 'frames2video') {
      const [firstPath, lastPath] = await Promise.all([
        stashRemoteOrDataUrlToTempFile(refs[0]),
        stashRemoteOrDataUrlToTempFile(refs[1]),
      ]);
      backend = await invoke<DreaminaBackendResult>('dreamina_frames2video', {
        prompt: payload.prompt,
        firstPath,
        lastPath,
        modelVersion: parsedEntry.model,
        duration,
        videoResolution: resolution,
        sessionId,
        pollSeconds: 180,
      });
    } else if (parsedEntry.command === 'multiframe2video') {
      const imagePaths = await Promise.all(refs.map(stashRemoteOrDataUrlToTempFile));
      backend = await invoke<DreaminaBackendResult>('dreamina_multiframe2video', {
        imagePaths,
        prompt: refs.length === 2 ? payload.prompt : undefined,
        duration: refs.length === 2 ? duration : undefined,
        transitionPrompts: refs.length >= 3 ? transitions?.map(({ prompt }) => prompt) : undefined,
        transitionDurations: refs.length >= 3 && transitions?.every(({ duration }) => duration !== undefined)
          ? transitions.map(({ duration }) => String(duration))
          : undefined,
        videoResolution: resolution,
        sessionId,
        pollSeconds: 240,
      });
    } else if (parsedEntry.command === 'multimodal2video') {
      const imagePaths = await Promise.all(refs.map(stashRemoteOrDataUrlToTempFile));
      const videoPaths = await Promise.all(referenceVideos.map(stageVideoReference));
      const audioPaths = await Promise.all(referenceAudios.map(stageAudioReference));
      backend = await invoke<DreaminaBackendResult>('dreamina_multimodal2video', {
        prompt: payload.prompt,
        imagePaths,
        videoPaths,
        audioPaths,
        modelVersion: parsedEntry.model,
        ratio: payload.aspectRatio === 'auto' ? undefined : payload.aspectRatio,
        duration,
        videoResolution: resolution,
        sessionId,
        pollSeconds: 240,
      });
    } else {
      backend = await invoke<DreaminaBackendResult>('dreamina_text2video', {
        prompt: payload.prompt,
        modelVersion: parsedEntry.model,
        ratio: payload.aspectRatio === 'auto' ? undefined : payload.aspectRatio,
        duration,
        videoResolution: resolution,
        sessionId,
        pollSeconds: 180,
      });
    }

    const submission = acceptedSubmission(backend);
    if (!submission.accepted || !submission.submitId) {
      return setFailedJob(jobId, backendFailure(backend));
    }
    const combined = `${backend.stdout}\n${backend.stderr}`;
    let resultUrl = extractResultUrl(combined, 'video');
    if (!resultUrl) {
      resultUrl = await pollDreaminaResult(jobId, submission.submitId, 'video', 8 * 60 * 1000);
    }
    if (!resultUrl) {
      const current = resultCache.get(jobId);
      if (current?.status !== 'failed') {
        setFailedJob(jobId, '即梦视频任务超过 8 分钟未返回结果，请使用 submit_id 在即梦任务记录中继续查询。');
      }
      return jobId;
    }
    resultCache.set(jobId, {
      job_id: jobId,
      status: 'succeeded',
      result: rewrapLocalPath(resultUrl),
      error: null,
    });
    return jobId;
  } catch (error) {
    return setFailedJob(
      jobId,
      humanizeDreaminaFailReason(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function clearDreaminaGatewayCacheForTests(): void {
  resultCache.clear();
}
