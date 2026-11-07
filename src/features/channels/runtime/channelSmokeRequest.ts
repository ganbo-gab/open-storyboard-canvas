import { renderPreview } from '../domain/template';
import type { ChannelProfileV2 } from '../domain/profile';
import type { JobInput, RequestPreview } from './types';

/** The durable template executor only consumes complete responses, never SSE. */
export function previewChannelSmokeRequest(profile: ChannelProfileV2, job: JobInput): RequestPreview {
  const preview = renderPreview(profile, job);
  const payload = job.chatPayload;
  const streamingPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    && (payload.stream === true || payload.action === 'streamGenerateContent' || payload.alt === 'sse');
  const streamingBody = preview.body.mode === 'json' && preview.body.json && typeof preview.body.json === 'object'
    && !Array.isArray(preview.body.json) && preview.body.json.stream === true;
  const streamingFields = (preview.body.mode === 'form-urlencoded' || preview.body.mode === 'multipart')
    && preview.body.fields.some((field) => field.name === 'stream' && field.value === 'true');
  const url = new URL(preview.url);
  const streamingHeader = Object.entries(preview.headers).some(([key, value]) => key.toLowerCase() === 'accept' && /text\/event-stream/i.test(value));
  if (job.params.stream === true || streamingPayload || streamingBody || streamingFields || streamingHeader
    || url.pathname.endsWith(':streamGenerateContent') || url.searchParams.get('alt') === 'sse') {
    throw new Error('渠道冒烟测试不支持 stream 流式响应；请求未发送');
  }
  return preview;
}
