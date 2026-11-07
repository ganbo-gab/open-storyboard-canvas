import { NodeMediaMetadata } from '../ui/NodeMediaMetadata';
import { memo, useEffect } from 'react';
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  type CanvasNodeType,
  type CanvasGenerationJobState,
  type ExportImageNodeData,
  type ImageEditNodeData,
  readGenerationReferenceFailure,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveMinEdgeFittedSize,
  resolveResizeMinConstraintsByAspect,
} from '@/features/canvas/application/imageNodeSizing';
import { useCanvasImageThumbnail } from '@/features/canvas/application/useCanvasImageThumbnail';
import {
  DEFAULT_GENERATED_IMAGE_DISPLAY_NAME,
  extractFileNameFromPath,
  resolveCustomGeneratedImageName,
} from '@/features/canvas/application/generatedMediaNaming';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { renameLocalMediaFiles } from '@/commands/image';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { NodeFrame } from '@/features/canvas/ui/NodeFrame';
import { BatchStackControl } from '@/features/canvas/ui/BatchStackControl';
import {
  GenerationProgress,
  ResultProblemFace,
  WaitingLabel,
  resolveResultFaceState,
  resultFaceStatus,
} from '@/features/canvas/ui/NodeGenerationFace';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { GenerationJobStatus } from '@/features/canvas/ui/GenerationJobStatus';
import { GenerationReferenceRetry } from '@/features/canvas/ui/GenerationReferenceRetry';
import { useCanvasStore } from '@/stores/canvasStore';

type ImageNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData | ExportImageNodeData;
  selected?: boolean;
};

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A generated (or generating) image result. */
export const ImageNode = memo(({ id, data, selected = false, type, width, height }: ImageNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const isResult = type === CANVAS_NODE_TYPES.exportImage;
  const isGenerating = data.isGenerating === true;
  const generationError = readText('generationError' in data ? data.generationError : undefined);
  const referenceFailure = isResult && generationError ? readGenerationReferenceFailure(data) : null;
  const generationWarning = readText(data.generationWarning);
  const jobState = typeof data.generationJobState === 'string' ? data.generationJobState as CanvasGenerationJobState : null;
  const jobPhase = typeof data.generationJobPhase === 'string' ? data.generationJobPhase : null;
  const networkRoute = data.generationNetworkRoute === 'system'
    || data.generationNetworkRoute === 'direct'
    || data.generationNetworkRoute === 'custom-proxy'
    ? data.generationNetworkRoute
    : null;
  const startedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const expectedDurationMs = typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 60_000;
  // Only result nodes track a job; an image source node never shows job failure states.
  const face = resolveResultFaceState({
    hasMedia: Boolean(data.imageUrl),
    busy: isGenerating || !isResult,
    jobState,
    error: referenceFailure ? t('reference.needsPublicUrl', { slotKey: referenceFailure.slotKey }) : generationError,
    safeRecovery: data.generationSafeRecoveryAvailable === true,
  });

  const aspectRatio = data.aspectRatio || DEFAULT_ASPECT_RATIO;
  const limits = { minWidth: EXPORT_RESULT_NODE_MIN_WIDTH, minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT };
  const compactSize = resolveMinEdgeFittedSize(aspectRatio, limits);
  const resizeMin = resolveResizeMinConstraintsByAspect(aspectRatio, limits);
  const frameWidth = typeof width === 'number' && width > 1 ? Math.round(width) : compactSize.width;
  const frameHeight = typeof height === 'number' && height > 1 ? Math.round(height) : compactSize.height;
  const title = resolveNodeDisplayName(type as CanvasNodeType, data);
  const finishedElapsed = isGenerating ? '' : formatGenerationElapsedMs('generationElapsedMs' in data ? data.generationElapsedMs : undefined);
  const batch = data.batchId && typeof data.batchIndex === 'number' && typeof data.batchTotal === 'number' && data.batchTotal > 1
    ? { id: data.batchId, index: data.batchIndex + 1, total: data.batchTotal, collapsed: data.batchCollapsed === true }
    : null;

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, frameHeight, frameWidth, updateNodeInternals]);

  const image = useCanvasImageThumbnail({
    imageUrl: data.imageUrl,
    previewImageUrl: data.previewImageUrl,
    width: frameWidth,
    height: frameHeight,
  });

  const rename = async (nextTitle: string) => {
    if (!isResult || !data.imageUrl) {
      updateNodeData(id, { displayName: nextTitle, ...(isResult ? { generatedNamingMode: 'custom' as const } : {}) });
      return;
    }
    const displayName = nextTitle.trim() || DEFAULT_GENERATED_IMAGE_DISPLAY_NAME;
    const desiredFileName = resolveCustomGeneratedImageName(displayName) ?? undefined;
    try {
      const renamed = await renameLocalMediaFiles({
        primaryPath: data.imageUrl,
        previewPath: data.previewImageUrl && data.previewImageUrl !== data.imageUrl ? data.previewImageUrl : undefined,
        desiredFileName,
        mediaKind: 'image',
      });
      updateNodeData(id, {
        displayName,
        imageUrl: renamed.primaryPath,
        previewImageUrl: renamed.previewPath ?? renamed.primaryPath,
        generatedFileName: renamed.fileName ?? extractFileNameFromPath(renamed.primaryPath),
        generatedNamingMode: desiredFileName ? 'custom' : 'default',
      });
    } catch (error) {
      console.warn('[ImageNode] failed to rename generated image file', { id, error });
      updateNodeData(id, {
        displayName,
        generatedFileName: desiredFileName ? data.generatedFileName ?? extractFileNameFromPath(data.imageUrl) : null,
        generatedNamingMode: desiredFileName ? 'custom' : 'default',
      });
    }
  };

  const status = resultFaceStatus(face, isGenerating, startedAt);

  return (
    <NodeFrame
      type={type as CanvasNodeType}
      selected={selected}
      icon={isResult ? <ImageIcon /> : <Sparkles />}
      title={title}
      onRename={(next) => void rename(next)}
      meta={<NodeMediaMetadata data={data} fallback={aspectRatio} />}
      status={status}
      badges={(
        <>
          {batch ? <BatchStackControl nodeId={id} batchId={batch.id} index={batch.index} total={batch.total} collapsed={batch.collapsed} selected={Boolean(selected)} /> : null}
          {finishedElapsed ? <span className="node-frame__badge" title={t('rework.canvas.node.elapsed')}>{finishedElapsed}</span> : null}
        </>
      )}
      variant="media"
      width={frameWidth}
      height={frameHeight}
      resize={{ minWidth: resizeMin.minWidth, minHeight: resizeMin.minHeight, maxWidth: 1600, maxHeight: 1600, keepAspectRatio: Boolean(data.imageUrl) }}
    >
      {data.imageUrl ? (
        <CanvasNodeImage
          src={image.src}
          fallbackSrcs={image.fallbackSrcs}
          pending={image.pending}
          alt={isResult ? t('node.imageNode.resultAlt') : t('node.imageNode.generatedAlt')}
          viewerSourceUrl={image.viewerSrc}
          className="h-full w-full object-contain"
        />
      ) : face.kind === 'waiting' ? (
        <div className="node-face">
          {isResult ? <ImageIcon /> : <Sparkles />}
          <span>
            {isGenerating ? (
              <WaitingLabel
                startedAt={startedAt}
                render={(minutes) => (minutes === null
                  ? t('node.imageNode.waitingResult')
                  : t('node.imageNode.waitingResultDelayed', { minutes }))}
              />
            ) : isResult ? t('node.imageNode.waitingResult') : t('node.imageNode.selectToEdit')}
          </span>
        </div>
      ) : (
        <ResultProblemFace
          face={face}
          failedTitle={t('node.imageNode.generationFailed')}
          action={referenceFailure ? <GenerationReferenceRetry nodeId={id} failure={referenceFailure} /> : null}
        />
      )}
      {isGenerating ? <GenerationProgress startedAt={startedAt} expectedDurationMs={expectedDurationMs} /> : null}
      <GenerationJobStatus state={isGenerating ? jobState : null} phase={jobPhase} networkRoute={networkRoute} />
      {generationWarning && data.imageUrl ? (
        <div className="node-warning" role="status" title={t('node.imageNode.providerWarning')}>
          <AlertTriangle />
          <span>{generationWarning}</span>
        </div>
      ) : null}
    </NodeFrame>
  );
});

ImageNode.displayName = 'ImageNode';
