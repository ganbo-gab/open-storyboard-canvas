import type { GenerateRequest } from '@/commands/ai';
import type { ChannelProfileV2 } from '../domain/profile';
import { resolveModelMode } from '../application/modelModes';
import { isImageModeOperation, resolveImageMode } from '../application/imageModeSelection';
import type { ChannelRequestOptions } from './channelExecution';
import type { JobRef } from './types';

const SOURCE_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg',
};
function sourceMime(source: string): string | undefined {
  const data = /^data:([^;,]+)/i.exec(source)?.[1];
  if (data) return data.toLowerCase();
  const asset = /^asset-media:([^:]+):/.exec(source)?.[1];
  if (asset) {
    try { return decodeURIComponent(asset).toLowerCase(); } catch { return undefined; }
  }
  const extension = /\.([a-z0-9]+)$/i.exec(source.split(/[?#]/, 1)[0])?.[1].toLowerCase();
  return extension ? SOURCE_MIMES[extension] : undefined;
}

/** Pure preflight shared by preview and submit. Encoding/materialization remains in resolveChannelRef. */
export function channelRequestOptions(profile: ChannelProfileV2, modelId: string, request: GenerateRequest): ChannelRequestOptions {
  const requestedModeId = request.channel_mode_id;
  const model = profile.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error('模型不在渠道声明中');
  const imageModes = Boolean(model.modes?.length) && model.modes!.every(mode => isImageModeOperation(mode.operation));
  if (!imageModes && request.reference_slots === undefined) {
    if (requestedModeId !== undefined) resolveModelMode(model, requestedModeId);
    return { modeId: requestedModeId };
  }
  let references = request.reference_slots;
  if (references !== undefined && (!references || typeof references !== 'object' || Array.isArray(references))) throw new Error('参考素材槽位必须是对象');
  if (references !== undefined) for (const sources of Object.values(references)) {
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string' || !source.trim())) throw new Error('参考素材槽位必须提供素材地址数组');
  }
  const imageSlotKeys = model.modes?.flatMap(mode => (mode.slots ?? []).filter(slot => slot.kind === 'image').map(slot => slot.key)) ?? [];
  const imageCount = references === undefined ? (request.reference_images?.length ?? 0)
    : Object.entries(references).reduce((count, [key, sources]) => count + (imageSlotKeys.includes(key) ? sources.length : 0), 0);
  const resolved = imageModes ? resolveImageMode(model, imageCount, requestedModeId) : resolveModelMode(model, requestedModeId);
  const modeId = imageModes ? resolved.mode.id : requestedModeId;
  const { slots } = resolved;
  if (references === undefined) {
    if ((request.reference_videos?.length ?? 0) > 0 || (request.reference_audios?.length ?? 0) > 0) throw new Error('图片模式的通用参考输入只接受图片，请手动分配其他素材槽位');
    const images = request.reference_images ?? [];
    if (!Array.isArray(images) || images.some(source => typeof source !== 'string' || !source.trim())) throw new Error('参考图片必须提供素材地址数组');
    const imageSlots = slots.filter(slot => slot.kind === 'image');
    if (images.length > 0 && imageSlots.length !== 1) throw new Error('当前模式有多个或没有图片槽位，请手动分配参考图片槽位');
    references = images.length > 0 ? { [imageSlots[0].key]: images } : {};
  }
  const refs: JobRef[] = [];
  for (const [key, sources] of Object.entries(references)) {
    const slot = slots.find((entry) => entry.key === key);
    if (!slot) throw new Error(`未声明参考素材槽位：${key}`);
    if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string' || !source.trim())) throw new Error(`槽位 ${slot.label} 必须提供素材地址数组`);
  }
  for (const slot of slots) {
    const sources = Object.hasOwn(references, slot.key) ? references[slot.key] : [];
    if (sources.length < (slot.min ?? 0) || sources.length > slot.max) throw new Error(`槽位 ${slot.label} 需要 ${slot.min ?? 0}–${slot.max} 个参考素材`);
    for (const [index, path] of sources.entries()) {
      const detectedMime = sourceMime(path);
      if (detectedMime && detectedMime !== 'application/octet-stream' && !detectedMime.startsWith(`${slot.kind}/`)) throw new Error(`槽位 ${slot.label} 只接受 ${slot.kind} 素材`);
      refs.push({ slot: slot.key, kind: slot.kind, assetId: `${slot.key}-${index}`, path,
        mime: detectedMime ?? (slot.kind === 'image' ? 'image/png' : slot.kind === 'video' ? 'video/mp4' : 'audio/mpeg') });
    }
  }
  return { modeId, refs };
}
