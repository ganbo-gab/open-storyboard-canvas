import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Film, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  type CanvasNodeType,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_GENERATED_VIDEO_DISPLAY_NAME,
  extractFileNameFromPath,
  resolveCustomGeneratedVideoName,
} from '@/features/canvas/application/generatedMediaNaming';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { renameLocalMediaFiles } from '@/commands/image';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { useCanvasStore } from '@/stores/canvasStore';

type VideoNodeProps = NodeProps & {
  id: string;
  data: VideoNodeData;
  selected?: boolean;
};

const VIDEO_NODE_DEFAULT_WIDTH = 384;
const VIDEO_NODE_DEFAULT_HEIGHT = 288;
const VIDEO_NODE_MIN_WIDTH = 256;
const VIDEO_NODE_MIN_HEIGHT = 180;
const VIDEO_NODE_MAX_WIDTH = 1600;
const VIDEO_NODE_MAX_HEIGHT = 1200;
const DEFAULT_VIDEO_GENERATION_DURATION_MS = 15 * 60 * 1000;

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

export const VideoNode = memo(({ id, data, selected, type, width, height }: VideoNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const [now, setNow] = useState(() => Date.now());

  const isGenerating = data.isGenerating === true;
  const videoSource = useMemo(() => {
    const source = data.localVideoUrl || data.videoUrl;
    return source ? resolveImageDisplayUrl(source) : null;
  }, [data.localVideoUrl, data.videoUrl]);
  const generationError = typeof data.generationError === 'string' ? data.generationError.trim() : '';
  const hasGenerationError = !isGenerating && !videoSource && generationError.length > 0;
  const generationStartedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs = typeof data.generationDurationMs === 'number' ? data.generationDurationMs : DEFAULT_VIDEO_GENERATION_DURATION_MS;
  const resolvedWidth = resolveNodeDimension(width, VIDEO_NODE_DEFAULT_WIDTH);
  const resolvedHeight = resolveNodeDimension(height, VIDEO_NODE_DEFAULT_HEIGHT);
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(type as CanvasNodeType, data),
    [data, type]
  );
  const generationElapsedText = formatGenerationElapsedMs(data.generationElapsedMs);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    if (!isGenerating) return;
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  const progress = useMemo(() => {
    if (!isGenerating) return 0;
    const startedAt = generationStartedAt ?? Date.now();
    const duration = Math.max(1000, generationDurationMs);
    return Math.min(Math.max(0, now - startedAt) / duration, 0.96);
  }, [generationDurationMs, generationStartedAt, isGenerating, now]);

  const waitedMinutes = useMemo(() => {
    if (!isGenerating || generationStartedAt === null) return 0;
    return Math.floor(Math.max(0, now - generationStartedAt) / 60000);
  }, [generationStartedAt, isGenerating, now]);

  const handleTitleChange = async (nextTitle: string) => {
    if (!data.localVideoUrl) {
      updateNodeData(id, {
        displayName: nextTitle,
        generatedNamingMode: 'custom',
      });
      return;
    }

    const normalizedTitle = nextTitle.trim() || DEFAULT_GENERATED_VIDEO_DISPLAY_NAME;
    const desiredFileName = resolveCustomGeneratedVideoName(normalizedTitle) ?? undefined;
    const fallbackPatch = {
      displayName: normalizedTitle,
      generatedFileName: desiredFileName
        ? data.generatedFileName ?? extractFileNameFromPath(data.localVideoUrl)
        : null,
      generatedNamingMode: desiredFileName ? 'custom' as const : 'default' as const,
    };

    try {
      const renamed = await renameLocalMediaFiles({
        primaryPath: data.localVideoUrl,
        desiredFileName,
        mediaKind: 'video',
      });
      const shouldPreserveVideoUrl = Boolean(data.videoUrl && data.videoUrl !== data.localVideoUrl);

      updateNodeData(id, {
        displayName: normalizedTitle,
        videoUrl: shouldPreserveVideoUrl ? data.videoUrl : renamed.primaryPath,
        localVideoUrl: renamed.primaryPath,
        generatedFileName: renamed.fileName ?? extractFileNameFromPath(renamed.primaryPath),
        generatedNamingMode: desiredFileName ? 'custom' : 'default',
      });
    } catch (error) {
      console.warn('[VideoNode] failed to rename generated video file', { id, error });
      updateNodeData(id, fallbackPatch);
    }
  };

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-0 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
        ${hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80')
          : selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Film className="h-4 w-4" />}
        titleText={resolvedTitle}
        titleClassName="inline-block max-w-[220px] truncate whitespace-nowrap align-bottom"
        editable
        onTitleChange={(nextTitle) => {
          void handleTitleChange(nextTitle);
        }}
        rightSlot={(
          <span className="flex items-center gap-1">
            {generationElapsedText ? (
              <span
                className="rounded-full bg-[rgba(15,23,42,0.72)] px-2 py-[1px] text-[10px] font-medium leading-tight text-white"
                title={t('node.videoNode.generationElapsed')}
              >
                {generationElapsedText}
              </span>
            ) : null}
            {data.durationSeconds ? (
              <span className="rounded-full bg-accent/80 px-2 py-[1px] text-[10px] font-medium leading-tight text-white">
                {data.durationSeconds}s
              </span>
            ) : null}
          </span>
        )}
      />

      <div
        className={`relative h-full w-full overflow-hidden rounded-[var(--node-radius)] ${hasGenerationError ? 'bg-[rgba(127,29,29,0.2)]' : 'bg-[var(--canvas-node-media-bg)]'}`}
      >
        {videoSource ? (
          <video
            src={videoSource}
            poster={data.thumbnailUrl ? resolveImageDisplayUrl(data.thumbnailUrl) : undefined}
            className="h-full w-full bg-black object-contain"
            controls
            playsInline
            preload="metadata"
          />
        ) : hasGenerationError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-medium leading-5 text-red-200">
              {t('node.videoNode.generationFailed')}
            </span>
            <span className="max-h-[96px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90">
              {generationError}
            </span>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
            {isGenerating ? (
              <Loader2 className="h-7 w-7 animate-spin opacity-70" />
            ) : (
              <Film className="h-7 w-7 opacity-60" />
            )}
            <span className="px-4 text-center text-[12px] leading-6">
              {isGenerating
                ? waitedMinutes >= 2
                  ? t('node.videoNode.waitingResultDelayed', { minutes: waitedMinutes })
                  : t('node.videoNode.waitingResult')
                : t('node.videoNode.empty')}
            </span>
          </div>
        )}

        {isGenerating && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 bg-bg-dark/55" />
            <div
              className="absolute left-0 top-0 h-full bg-gradient-to-r from-[rgba(255,255,255,0.34)] to-[rgba(255,255,255,0.05)] transition-[width] duration-100 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={VIDEO_NODE_MIN_WIDTH}
        minHeight={VIDEO_NODE_MIN_HEIGHT}
        maxWidth={VIDEO_NODE_MAX_WIDTH}
        maxHeight={VIDEO_NODE_MAX_HEIGHT}
      />
    </div>
  );
});

VideoNode.displayName = 'VideoNode';
