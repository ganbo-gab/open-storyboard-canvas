import type { GenerateRequest } from '@/commands/ai';
import type { CustomProviderPreset } from '@/stores/customProvidersStore';
import type { VideoInputSchema } from './videoInputSchema';

export const MINIMAX_H3_INPUT_SCHEMA: VideoInputSchema = {
  images: { enabled: true, min: 0, max: 9, roles: ['reference', 'firstFrame', 'lastFrame'], requireImageHost: false },
  video: { enabled: true, min: 0, max: 3, field: 'content' },
  audio: { enabled: true, min: 0, max: 3, field: 'content' },
  imageModes: ['reference', 'firstFrame', 'lastFrame', 'frames'],
};

export const MINIMAX_H3_PRESET = {
  key: 'minimax_h3',
  label: 'MiniMax H3',
  hint: 'minimaxH3.hint',
  template: {
    label: 'MiniMax H3',
    mediaType: 'video',
    baseUrl: 'https://api.minimax.io',
    endpointPath: '/v2/video_generation',
    httpMethod: 'POST',
    apiStyle: 'generic-json',
    responseFormat: 'generic',
    models: ['MiniMax-H3'],
    supportsWebSearch: false,
    supportedResolutions: ['768P', '2K'],
    extraParams: {
      providerKind: 'minimax-h3',
      videoRequestBodyMode: 'json',
      supportedDurations: ['5', '4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
      supportedRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
      videoTaskIdPath: 'task_id',
      videoStatusEndpointPath: '/v2/query/video_generation/{taskId}',
      videoStatusMethod: 'GET',
      videoStatusPath: 'task.status',
      videoErrorPath: 'task.error',
      responseVideoPath: 'task.content.url',
      videoPendingValues: ['queued', 'running'],
      videoSuccessValues: ['succeeded'],
      videoFailedValues: ['failed', 'cancelled'],
      videoPollIntervalMs: 10000,
      videoPollTimeoutMs: 20 * 60 * 1000,
      videoInputSchema: MINIMAX_H3_INPUT_SCHEMA,
      defaultRequestParams: { duration: 5, resolution: '768P', imageMode: 'reference' },
    },
    note: 'minimaxH3.note',
  },
} satisfies CustomProviderPreset;

export type MinimaxH3ValidationCode = 'model' | 'prompt' | 'duration' | 'resolution' | 'ratio' | 'textRatio' | 'mode' | 'frames' | 'mixed' | 'limits' | 'media' | 'bodySize';
export class MinimaxH3ValidationError extends Error {
  constructor(readonly code: MinimaxH3ValidationCode) {
    super(`minimaxH3.errors.${code}`);
    this.name = 'MinimaxH3ValidationError';
  }
}

function invalid(code: MinimaxH3ValidationCode): never {
  throw new MinimaxH3ValidationError(code);
}

function mediaUrl(value: string, type: 'image' | 'video' | 'audio'): string {
  const source = value.trim();
  if (new RegExp(`^data:${type}/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$`, 'i').test(source)) return source;
  try {
    const url = new URL(source);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return source;
  } catch { /* Local files must be converted before reaching the composer. */ }
  return invalid('media');
}

/** Pure V2 wire composer. Only documented fields leave this boundary. */
export function composeMinimaxH3Request(
  model: string,
  request: GenerateRequest,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  if (model !== 'MiniMax-H3') invalid('model');
  if (!request.prompt.trim() || Array.from(request.prompt).length > 7000) invalid('prompt');
  const params = request.extra_params ?? {};
  const rawDuration = params.seconds ?? params.duration ?? defaults.duration ?? defaults.seconds ?? 5;
  const duration = typeof rawDuration === 'number' || (typeof rawDuration === 'string' && /^\d+$/.test(rawDuration))
    ? Number(rawDuration) : NaN;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) invalid('duration');
  const resolution = params.resolutionType ?? params.resolution ?? params.size ?? (request.size || defaults.resolution || '768P');
  if (resolution !== '768P' && resolution !== '2K') invalid('resolution');
  const images = request.reference_images ?? [];
  const videos = request.reference_videos ?? [];
  const audios = request.reference_audios ?? [];
  if (images.length > 9 || videos.length > 3 || audios.length > 3 || images.length + videos.length + audios.length > 12) invalid('limits');
  const mode = params.imageMode ?? defaults.imageMode ?? 'reference';
  if (!['reference', 'firstFrame', 'lastFrame', 'frames'].includes(String(mode))) invalid('mode');
  const frameMode = mode !== 'reference';
  if (frameMode && (videos.length || audios.length)) invalid('mixed');
  if (frameMode && images.length !== (mode === 'frames' ? 2 : 1)) invalid('frames');
  const requestedRatio = params.aspectRatio ?? params.aspect_ratio ?? request.aspect_ratio ?? defaults.ratio;
  const ratio = frameMode ? 'adaptive' : (requestedRatio || (images.length + videos.length + audios.length ? 'adaptive' : '16:9'));
  if (!['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(String(ratio))) invalid('ratio');
  if (!images.length && !videos.length && !audios.length && ratio === 'adaptive') invalid('textRatio');
  const content: Record<string, unknown>[] = [{ type: 'text', text: request.prompt }];
  images.forEach((source, index) => {
    const role = mode === 'reference' ? 'reference_image' : mode === 'lastFrame' || (mode === 'frames' && index === 1) ? 'last_frame' : 'first_frame';
    content.push({ type: 'image_url', image_url: { url: mediaUrl(source, 'image') }, role });
  });
  videos.forEach((source) => content.push({ type: 'video_url', video_url: { url: mediaUrl(source, 'video') }, role: 'reference_video' }));
  audios.forEach((source) => content.push({ type: 'audio_url', audio_url: { url: mediaUrl(source, 'audio') }, role: 'reference_audio' }));
  const body = { model, content, duration, resolution, ratio };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024 * 1024) invalid('bodySize');
  return body;
}
