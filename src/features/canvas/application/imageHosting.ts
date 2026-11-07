import { customHttpRequest, type CustomHttpMultipartBody } from '@/commands/ai';
import { normalizeImageHostSettings, imageHostConfigurationError, type ImageHostSettings } from '@/features/settings/imageHostSettings';
import { getPath } from '@/features/channels/domain/response';
import { isPublicReferenceUrl } from '@/features/channels/domain/referenceErrors';
import { imageUrlToDataUrl } from './imageData';

function dataUrlExtension(dataUrl: string): string {
  const match = /^data:image\/([a-z0-9.+-]+);/i.exec(dataUrl);
  const raw = match?.[1]?.toLowerCase() ?? '';
  if (raw === 'jpeg') return 'jpg';
  if (raw === 'png' || raw === 'jpg' || raw === 'webp' || raw === 'gif' || raw === 'bmp' || raw === 'avif') {
    return raw;
  }
  return 'png';
}

function imageFileFromDataUrl(dataUrl: string, index: number, fieldName: string): NonNullable<CustomHttpMultipartBody['files']>[number] {
  const extension = dataUrlExtension(dataUrl);
  return {
    name: fieldName,
    fileName: `reference-${index + 1}.${extension}`,
    dataUrl,
  };
}

/** Called only by the explicit reference-upload action; never selects a default external service. */
export async function uploadImageToConfiguredHost(source: string, index: number, rawSettings: ImageHostSettings): Promise<string> {
  if (isPublicReferenceUrl(source.trim())) return source.trim();
  const settings = normalizeImageHostSettings(rawSettings);
  if (!settings.enabled) throw new Error('settings.imageHosting.errors.disabled');
  const configurationError = imageHostConfigurationError(settings);
  if (configurationError) throw new Error(configurationError);
  const dataUrl = await imageUrlToDataUrl(source);
  const response = await customHttpRequest({
    url: settings.uploadUrl.trim(), method: 'POST',
    headers: { Accept: 'application/json', ...settings.extraHeaders },
    bodyMode: 'multipart', multipart: { files: [imageFileFromDataUrl(dataUrl, index, settings.fileField.trim())] },
    timeoutMs: 60000,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`自定义图床上传失败：HTTP ${response.status}`);
  let payload: unknown;
  try { payload = JSON.parse(response.text); }
  catch { throw new Error('图床返回内容不是有效 JSON，请检查响应 URL 字段。'); }
  const result = getPath(payload, settings.responseUrlPath.trim().replace(/^\$\./, ''));
  if (typeof result !== 'string' || !isPublicReferenceUrl(result.trim())) {
    throw new Error('图床响应中的指定字段不是公开图片 URL，请检查响应 URL 字段。');
  }
  return result.trim();
}
