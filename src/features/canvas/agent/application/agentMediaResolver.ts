import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  buildCanvasAssetCatalog,
  type CanvasAssetCatalogItem,
} from '@/features/canvas/application/canvasAssetCatalog';
import {
  imageUrlToDataUrl,
  isLikelyLocalImagePath,
} from '@/features/canvas/application/imageData';
import type { AgentTurnMediaInput } from '../domain/agentModel';

interface AgentMediaGrant { runId: string; nodeId: string; source: string; mimeType: string; expiresAt: number; }
const grants = new Map<string, AgentMediaGrant>();
export const MAX_AGENT_MEDIA_ATTACHMENTS = 8;
export const MAX_AGENT_MEDIA_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_AGENT_MEDIA_PIXELS = 40_000_000;
export const MAX_AGENT_MEDIA_EDGE = 16_384;
const MAX_INLINE_SOURCE_CHARACTERS = 14 * 1024 * 1024;
const OPAQUE_MEDIA_REFERENCE_PREFIX = 'agent-media-ref:';
const SUPPORTED_AGENT_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const NODE_MEDIA_FIELDS = [
  'previewImageUrl',
  'imageUrl',
  'snapshotUrl',
  'resultImageUrl',
  'thumbnailUrl',
] as const;

function sourceMimeType(source: string): string {
  const dataMatch = source.match(/^data:([^;,]+)[;,]/i);
  if (dataMatch) return dataMatch[1].toLowerCase();
  if (/\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(source)) return 'image/remote';
  if (/^(?:https?:|blob:|asset:)/i.test(source)) return 'image/unknown';
  return 'unknown';
}

function assertSafeImageSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) throw new Error('图片引用为空。');
  if (trimmed.length > MAX_INLINE_SOURCE_CHARACTERS) throw new Error('图片引用超过本轮多模态大小限制。');
  if (/^(?:file:|~[\\/]|[A-Za-z]:\\|\/(?:Users|home|private|var|tmp)(?:\/|$))/i.test(trimmed)) {
    throw new Error('Agent 不能读取本地绝对路径，请先把图片导入画布。');
  }
  const mimeType = sourceMimeType(trimmed);
  if (mimeType !== 'image/remote' && mimeType !== 'image/unknown' && !mimeType.startsWith('image/')) {
    throw new Error('当前引用不是受支持的图片媒体。');
  }
  return mimeType;
}

export function findAgentNodeImageSource(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const field of NODE_MEDIA_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      assertSafeImageSource(value);
      return value;
    } catch {
      // Keep looking for a safe preview/source field.
    }
  }
  return null;
}

export async function validateAgentImageFile(file: File): Promise<void> {
  if (!SUPPORTED_AGENT_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
    throw new Error('仅支持 PNG、JPEG、WebP、GIF 或 AVIF 图片。');
  }
  if (file.size <= 0) throw new Error('图片文件为空。');
  if (file.size > MAX_AGENT_MEDIA_FILE_BYTES) {
    throw new Error('单张图片不能超过 10 MB。');
  }
  if (typeof createImageBitmap !== 'function') return;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const pixels = bitmap.width * bitmap.height;
    if (bitmap.width > MAX_AGENT_MEDIA_EDGE || bitmap.height > MAX_AGENT_MEDIA_EDGE) {
      throw new Error(`图片边长不能超过 ${MAX_AGENT_MEDIA_EDGE} 像素。`);
    }
    if (pixels > MAX_AGENT_MEDIA_PIXELS) {
      throw new Error('图片总像素不能超过 4000 万。');
    }
  } catch (error) {
    if (error instanceof Error && /不能超过/.test(error.message)) throw error;
    throw new Error('无法解码这张图片，请换一张有效图片。');
  } finally {
    bitmap?.close();
  }
}

export function createAgentCanvasMediaInput(asset: CanvasAssetCatalogItem): AgentTurnMediaInput {
  if (asset.kind !== 'image') throw new Error('Agent 附件只能引用画布图片资产。');
  return {
    assetId: asset.id,
    nodeId: asset.nodeId,
    title: asset.title,
    origin: 'canvas-asset',
    source: asset.previewUrl || asset.url,
  };
}

export function validateAgentTurnMediaInputs(
  media: AgentTurnMediaInput[],
): AgentTurnMediaInput[] {
  if (media.length > MAX_AGENT_MEDIA_ATTACHMENTS) {
    throw new Error(`单轮最多引用 ${MAX_AGENT_MEDIA_ATTACHMENTS} 张图片。`);
  }
  const seen = new Set<string>();
  return media.map((item) => {
    const assetId = item.assetId.trim();
    if (!assetId) throw new Error('图片附件缺少稳定 assetId。');
    if (seen.has(assetId)) throw new Error(`图片附件 ${assetId} 重复。`);
    seen.add(assetId);
    if (item.origin === 'canvas-asset' && !item.nodeId?.trim()) {
      throw new Error(`画布图片 ${assetId} 缺少稳定 nodeId。`);
    }
    assertSafeImageSource(item.source);
    return {
      ...item,
      assetId,
      nodeId: item.nodeId?.trim() || undefined,
      title: item.title.trim().slice(0, 240) || assetId,
    };
  });
}

export async function prepareAgentMediaSource(source: string): Promise<string> {
  const normalized = source.trim();
  if (!normalized) throw new Error('图片引用为空。');
  const needsInlineData = isLikelyLocalImagePath(normalized)
    || /^(?:file:|asset:|tauri:|blob:)/i.test(normalized);
  const prepared = needsInlineData ? await imageUrlToDataUrl(normalized) : normalized;
  assertSafeImageSource(prepared);
  return prepared;
}

export function createAgentMediaReference(
  runId: string,
  nodeId: string,
  source: string,
  ttlMs = 10 * 60_000,
  referenceKey = nodeId,
): { id: string } {
  if (!runId.trim() || !nodeId.trim()) throw new Error('图片引用缺少 runId 或 nodeId。');
  const runGrantCount = Array.from(grants.values()).filter((grant) => grant.runId === runId).length;
  const id = `${runId}:${referenceKey}`;
  if (runGrantCount >= MAX_AGENT_MEDIA_ATTACHMENTS && !grants.has(id)) {
    throw new Error(`单轮最多引用 ${MAX_AGENT_MEDIA_ATTACHMENTS} 张画布图片。`);
  }
  const mimeType = assertSafeImageSource(source);
  grants.set(id, { runId, nodeId, source, mimeType, expiresAt: Date.now() + Math.min(Math.max(ttlMs, 30_000), 30 * 60_000) });
  return { id };
}

export function toOpaqueAgentMediaReference(reference: { id: string }): string {
  return `${OPAQUE_MEDIA_REFERENCE_PREFIX}${encodeURIComponent(reference.id)}`;
}

export function resolveOpaqueAgentMediaReference(value: string): string | null {
  if (!value.startsWith(OPAQUE_MEDIA_REFERENCE_PREFIX)) return null;
  try {
    return resolveAgentMediaReference(decodeURIComponent(value.slice(OPAQUE_MEDIA_REFERENCE_PREFIX.length)));
  } catch {
    return null;
  }
}

export function resolveAgentMediaReference(id: string, now = Date.now()): string | null {
  const grant = grants.get(id);
  if (!grant || grant.expiresAt <= now) { grants.delete(id); return null; }
  return grant.source;
}

export function restoreAgentMediaReferenceFromCanvas(
  id: string,
  nodes: CanvasNode[],
  now = Date.now(),
): string | null {
  const existing = resolveAgentMediaReference(id, now);
  if (existing) return existing;
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) return null;
  const runId = id.slice(0, separator);
  const assetId = id.slice(separator + 1);
  const asset = buildCanvasAssetCatalog(nodes).find((item) => item.id === assetId && item.kind === 'image');
  if (!asset) return null;
  try {
    const mimeType = assertSafeImageSource(asset.url);
    grants.set(id, {
      runId,
      nodeId: asset.nodeId,
      source: asset.url,
      mimeType,
      expiresAt: now + 10 * 60_000,
    });
    return asset.url;
  } catch {
    return null;
  }
}

export function agentMediaAssetIdFromReference(referenceId: string): string | null {
  const separator = referenceId.indexOf(':');
  if (separator <= 0 || separator === referenceId.length - 1) return null;
  return referenceId.slice(separator + 1);
}

export function revokeAgentMediaRun(runId: string): void {
  for (const [id, grant] of grants) if (grant.runId === runId) grants.delete(id);
}

export function inspectAgentMediaReference(id: string, now = Date.now()): { runId: string; nodeId: string; mimeType: string; expiresAt: number } | null {
  const grant = grants.get(id);
  if (!grant || grant.expiresAt <= now) return null;
  return { runId: grant.runId, nodeId: grant.nodeId, mimeType: grant.mimeType, expiresAt: grant.expiresAt };
}
