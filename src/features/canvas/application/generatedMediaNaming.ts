import type {
  CanvasNode,
  ExportImageNodeData,
  VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

export const DEFAULT_GENERATED_IMAGE_DISPLAY_NAME = '生成图像';
export const DEFAULT_GENERATED_VIDEO_DISPLAY_NAME = '生成视频';
export const DEFAULT_GENERATED_PROMPT_STEM = 'untitled';

const LEGACY_IMAGE_DEFAULT_NAMES = new Set([
  DEFAULT_GENERATED_IMAGE_DISPLAY_NAME,
  '结果图片',
]);

const LEGACY_VIDEO_DEFAULT_NAMES = new Set([
  DEFAULT_GENERATED_VIDEO_DISPLAY_NAME,
  '结果视频',
]);

function sanitizeFileStem(raw: string | null | undefined, fallback: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return fallback;

  const sanitized = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.+$/g, '')
    .trim();

  return sanitized || fallback;
}

function sanitizeDisplayStem(raw: string | null | undefined, fallback: string): string {
  const trimmed = typeof raw === 'string'
    ? raw.replace(/\s+/g, '').trim()
    : '';
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.+$/g, '')
    .trim();
  return sanitized || fallback;
}

function normalizeGeneratedSequence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(value));
}

function formatGeneratedSequence(sequence: number, width: number): string {
  return String(Math.max(1, Math.floor(sequence))).padStart(width, '0');
}

export function getLocalDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function extractFileNameFromPath(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const normalized = trimmed.toLowerCase().startsWith('file://')
      ? decodeURIComponent(trimmed.replace(/^file:\/\//i, ''))
      : trimmed;
    const parts = normalized.split(/[\\/]/);
    const fileName = parts[parts.length - 1]?.trim();
    return fileName || null;
  } catch {
    const parts = trimmed.split(/[\\/]/);
    const fileName = parts[parts.length - 1]?.trim();
    return fileName || null;
  }
}

function extractFileExtension(fileName: string | null | undefined, fallback: string): string {
  const value = fileName ?? '';
  const lastDot = value.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === value.length - 1) return fallback;
  return value.slice(lastDot + 1);
}

export function stripFileExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0) return trimmed;
  return trimmed.slice(0, lastDot);
}

export function resolveCustomGeneratedImageName(displayName: string | null | undefined): string | null {
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (!trimmed || LEGACY_IMAGE_DEFAULT_NAMES.has(trimmed)) return null;
  return trimmed;
}

export function resolveCustomGeneratedVideoName(displayName: string | null | undefined): string | null {
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (!trimmed || LEGACY_VIDEO_DEFAULT_NAMES.has(trimmed)) return null;
  return trimmed;
}

export function resolveGeneratedPromptSnippet(
  prompt: string | null | undefined,
  maxChars = 12
): string {
  const stem = sanitizeDisplayStem(prompt, DEFAULT_GENERATED_PROMPT_STEM);
  return stem.length > maxChars ? stem.slice(0, maxChars) : stem;
}

export function resolveDefaultGeneratedImageDisplayName(
  sequence: number,
  prompt: string | null | undefined
): string {
  return `img_${formatGeneratedSequence(sequence, 3)}_${resolveGeneratedPromptSnippet(prompt)}`;
}

export function resolveDefaultGeneratedVideoDisplayName(
  sequence: number,
  prompt: string | null | undefined
): string {
  return `video_${formatGeneratedSequence(sequence, 3)}_${resolveGeneratedPromptSnippet(prompt)}`;
}

export function resolveDefaultGeneratedImageFileStem(
  sequence: number,
  dateStamp: string
): string {
  return `genimg_${dateStamp}_${formatGeneratedSequence(sequence, 4)}`;
}

export function resolveDefaultGeneratedVideoFileStem(
  sequence: number,
  dateStamp: string
): string {
  return `genvideo_${dateStamp}_${formatGeneratedSequence(sequence, 4)}`;
}

export function resolveNextGeneratedMediaSequence(
  mediaKind: 'image' | 'video',
  nodes: CanvasNode[],
  excludeNodeIds: Iterable<string> = []
): number {
  const excludedIds = new Set(excludeNodeIds);
  const nodeType = mediaKind === 'image' ? CANVAS_NODE_TYPES.exportImage : CANVAS_NODE_TYPES.video;
  let maxSequence = 0;
  for (const node of nodes) {
    if (excludedIds.has(node.id) || node.type !== nodeType) {
      continue;
    }
    const value = (node.data as Record<string, unknown>).generatedSequence;
    if (typeof value === 'number' && Number.isFinite(value) && value > maxSequence) {
      maxSequence = Math.floor(value);
    }
  }
  return maxSequence + 1;
}

export function resolveGeneratedImageSaveFileName(
  data: Partial<ExportImageNodeData>,
  fallbackExtension = 'png'
): string {
  const generatedFileName = data.generatedFileName?.trim() || null;
  const isCustom = data.generatedNamingMode === 'custom';
  const customName = isCustom ? resolveCustomGeneratedImageName(data.displayName) : null;
  const sourceFileName = extractFileNameFromPath(data.imageUrl);
  const extension = extractFileExtension(generatedFileName ?? sourceFileName, fallbackExtension);
  if (customName) {
    return `${sanitizeFileStem(customName, DEFAULT_GENERATED_IMAGE_DISPLAY_NAME)}.${extension}`;
  }
  if (generatedFileName) return generatedFileName;
  const sequence = normalizeGeneratedSequence(data.generatedSequence);
  if (sequence) {
    return `${resolveDefaultGeneratedImageFileStem(sequence, data.generatedDateStamp?.trim() || getLocalDateStamp())}.${extension}`;
  }
  return `${DEFAULT_GENERATED_IMAGE_DISPLAY_NAME}.${extension}`;
}

export function resolveGeneratedVideoSaveFileName(
  data: Partial<VideoNodeData>,
  fallbackExtension = 'mp4'
): string {
  const generatedFileName = data.generatedFileName?.trim() || null;
  const isCustom = data.generatedNamingMode === 'custom';
  const customName = isCustom ? resolveCustomGeneratedVideoName(data.displayName) : null;
  const sourceFileName = extractFileNameFromPath(data.localVideoUrl || data.videoUrl);
  const extension = extractFileExtension(generatedFileName ?? sourceFileName, fallbackExtension);
  if (customName) {
    return `${sanitizeFileStem(customName, DEFAULT_GENERATED_VIDEO_DISPLAY_NAME)}.${extension}`;
  }
  if (generatedFileName) return generatedFileName;
  const sequence = normalizeGeneratedSequence(data.generatedSequence);
  if (sequence) {
    return `${resolveDefaultGeneratedVideoFileStem(sequence, data.generatedDateStamp?.trim() || getLocalDateStamp())}.${extension}`;
  }
  return `${DEFAULT_GENERATED_VIDEO_DISPLAY_NAME}.${extension}`;
}

export function resolveSuggestedImageStem(data: Partial<ExportImageNodeData>): string {
  return stripFileExtension(resolveGeneratedImageSaveFileName(data));
}

export function resolveSuggestedVideoStem(data: Partial<VideoNodeData>): string {
  return stripFileExtension(resolveGeneratedVideoSaveFileName(data));
}
