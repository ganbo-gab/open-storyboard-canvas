import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { CURRENT_RUNTIME_SESSION_ID } from '@/features/canvas/application/generationErrorReport';

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isLocalFilesystemResultSource(value: unknown): boolean {
  const source = nonEmptyString(value);
  if (!source) {
    return false;
  }

  return (
    source.startsWith('/')
    || /^file:\/\//i.test(source)
    || /^[a-zA-Z]:[\\/]/.test(source)
    || source.startsWith('\\\\')
  );
}

export function isLightweightGenerationRetryResultUrl(value: unknown): boolean {
  const url = nonEmptyString(value);
  if (!url) {
    return false;
  }
  const normalizedPrefix = url.slice(0, 16).toLowerCase();
  return (
    !normalizedPrefix.startsWith('data:')
    && !normalizedPrefix.startsWith('blob:')
    && !isLocalFilesystemResultSource(url)
  );
}

function isRetryableResultNodeType(node: CanvasNode): boolean {
  return (
    node.type === CANVAS_NODE_TYPES.exportImage
    || node.type === CANVAS_NODE_TYPES.panorama
    || node.type === CANVAS_NODE_TYPES.video
  );
}

function hasResultMedia(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  if (node.type === CANVAS_NODE_TYPES.video) {
    return Boolean(nonEmptyString(data.videoUrl) || nonEmptyString(data.localVideoUrl));
  }
  return Boolean(nonEmptyString(data.imageUrl) || nonEmptyString(data.previewImageUrl));
}

export function canRetryGenerationFetch(node: CanvasNode | null | undefined): boolean {
  if (!node || !isRetryableResultNodeType(node)) {
    return false;
  }

  const data = node.data as Record<string, unknown>;
  const hasError = nonEmptyString(data.generationError).length > 0;
  const hasRetrySource = Boolean(
    nonEmptyString(data.generationJobId)
    || isLightweightGenerationRetryResultUrl(data.generationRetryResultUrl)
  );

  return data.isGenerating !== true && hasError && !hasResultMedia(node) && hasRetrySource;
}

export function buildRetryGenerationFetchPatch(node: CanvasNode): Partial<CanvasNodeData> {
  const data = node.data as Record<string, unknown>;
  const currentDuration = typeof data.generationDurationMs === 'number' && Number.isFinite(data.generationDurationMs)
    ? data.generationDurationMs
    : node.type === CANVAS_NODE_TYPES.video
      ? 15 * 60 * 1000
      : 60 * 1000;

  return {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationDurationMs: Math.max(1000, Math.round(currentDuration)),
    generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
    generationError: null,
    generationErrorDetails: null,
  };
}
