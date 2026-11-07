import { BatchStackControl } from '@/features/canvas/ui/BatchStackControl';
import { NodeMediaMetadata } from '../ui/NodeMediaMetadata';
import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Film, Loader2, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type CanvasGenerationJobState,
  type CanvasNodeType,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_GENERATED_VIDEO_DISPLAY_NAME,
  extractFileNameFromPath,
  resolveCustomGeneratedVideoName,
} from '@/features/canvas/application/generatedMediaNaming';
import { useAssetDisplaySource } from '@/features/assets/ui/useAssetDisplaySource';
import { isNodeUsingDefaultDisplayName, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { isVideoFile, resolveDroppedVideoFile } from '@/features/canvas/application/imageDragDrop';
import { prepareVideoNodeDataFromFile } from '@/features/canvas/application/videoUpload';
import { renameLocalMediaFiles } from '@/commands/image';
import { NodeFrame } from '@/features/canvas/ui/NodeFrame';
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
import { useSettingsStore } from '@/stores/settingsStore';

type VideoNodeProps = NodeProps & {
  id: string;
  data: VideoNodeData;
  selected?: boolean;
};

const DEFAULT_SIZE = { width: 384, height: 288 };
const RESIZE = { minWidth: 256, minHeight: 180, maxWidth: 1600, maxHeight: 1200, keepAspectRatio: true } as const;
const DEFAULT_VIDEO_GENERATION_DURATION_MS = 15 * 60 * 1000;
const VIDEO_ACCEPT = 'video/*,.mp4,.webm,.mov,.m4v,.avi,.mkv,.mpeg,.mpg,.3gp,.3gpp';

/** Video material or a generated video result. Click / drop to import when empty. */
export const VideoNode = memo(({ id, data, selected = false, type, width, height }: VideoNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const inputRef = useRef<HTMLInputElement>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const useFileNameAsTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const isGenerating = data.isGenerating === true;
  const source = data.localVideoUrl || data.videoUrl || null;
  const videoSource = useAssetDisplaySource(source).url;
  const posterSource = useAssetDisplaySource(data.thumbnailUrl).url;
  const generationError = typeof data.generationError === 'string' ? data.generationError.trim() : '';
  const referenceFailure = generationError ? data.generationReferenceFailure ?? null : null;
  const jobState = typeof data.generationJobState === 'string' ? data.generationJobState as CanvasGenerationJobState : null;
  const startedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const face = resolveResultFaceState({
    hasMedia: Boolean(source),
    busy: isGenerating || isUploading,
    jobState,
    error: uploadError.trim() || (referenceFailure ? t('reference.needsPublicUrl', { slotKey: referenceFailure.slotKey }) : generationError),
    safeRecovery: data.generationSafeRecoveryAvailable === true,
  });
  const frameWidth = typeof width === 'number' && width > 1 ? Math.round(width) : DEFAULT_SIZE.width;
  const frameHeight = typeof height === 'number' && height > 1 ? Math.round(height) : DEFAULT_SIZE.height;
  const title = useMemo(() => {
    const fileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    return useFileNameAsTitle && fileName && isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.video, data)
      ? fileName
      : resolveNodeDisplayName(type as CanvasNodeType, data);
  }, [data, type, useFileNameAsTitle]);
  const finishedElapsed = isGenerating ? '' : formatGenerationElapsedMs(data.generationElapsedMs);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, frameHeight, frameWidth, updateNodeInternals]);

  useEffect(() => {
    if (source) setUploadError('');
  }, [source]);

  const importFile = async (file: File) => {
    if (!isVideoFile(file)) return;
    setIsUploading(true);
    setUploadError('');
    try {
      const prepared = await prepareVideoNodeDataFromFile(file);
      updateNodeData(id, useFileNameAsTitle ? { ...prepared, displayName: file.name } : prepared);
    } catch (error) {
      console.error('[VideoNode] failed to import local video', { id, fileName: file.name, error });
      setUploadError((error instanceof Error ? error.message : String(error)) || t('node.videoNode.uploadFailed'));
    } finally {
      setIsUploading(false);
    }
  };

  const rename = async (nextTitle: string) => {
    if (!data.localVideoUrl) {
      updateNodeData(id, { displayName: nextTitle, generatedNamingMode: 'custom' });
      return;
    }
    const displayName = nextTitle.trim() || DEFAULT_GENERATED_VIDEO_DISPLAY_NAME;
    const desiredFileName = resolveCustomGeneratedVideoName(displayName) ?? undefined;
    try {
      const renamed = await renameLocalMediaFiles({ primaryPath: data.localVideoUrl, desiredFileName, mediaKind: 'video' });
      const keepRemoteUrl = Boolean(data.videoUrl && data.videoUrl !== data.localVideoUrl);
      updateNodeData(id, {
        displayName,
        videoUrl: keepRemoteUrl ? data.videoUrl : renamed.primaryPath,
        localVideoUrl: renamed.primaryPath,
        generatedFileName: renamed.fileName ?? extractFileNameFromPath(renamed.primaryPath),
        generatedNamingMode: desiredFileName ? 'custom' : 'default',
      });
    } catch (error) {
      console.warn('[VideoNode] failed to rename generated video file', { id, error });
      updateNodeData(id, {
        displayName,
        generatedFileName: desiredFileName ? data.generatedFileName ?? extractFileNameFromPath(data.localVideoUrl) : null,
        generatedNamingMode: desiredFileName ? 'custom' : 'default',
      });
    }
  };

  const canImport = !source && !isGenerating && !isUploading && face.kind === 'waiting' && !data.generationJobId;
  const stopDrag = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <NodeFrame
      type={type as CanvasNodeType}
      selected={selected}
      icon={<Film />}
      title={title}
      onRename={(next) => void rename(next)}
      meta={<NodeMediaMetadata data={data} fallback={data.durationSeconds ? `${data.durationSeconds}s` : data.aspectRatio} />}
      status={resultFaceStatus(face, isGenerating, startedAt)}
      badges={<>{finishedElapsed ? <span className="node-frame__badge" title={t('node.videoNode.generationElapsed')}>{finishedElapsed}</span> : null}{typeof data.batchId === 'string' && data.batchId && typeof data.batchIndex === 'number' && typeof data.batchTotal === 'number' && data.batchTotal > 1 ? <BatchStackControl nodeId={id} batchId={data.batchId} index={data.batchIndex+1} total={data.batchTotal} collapsed={data.batchCollapsed===true} selected={Boolean(selected)} /> : null}</>}
      actions={source ? (
        <button
          type="button"
          className="nodrag"
          aria-label={t('node.videoNode.replace')}
          title={t('node.videoNode.replace')}
          onClick={(event) => {
            event.stopPropagation();
            inputRef.current?.click();
          }}
        >
          <RefreshCw />
        </button>
      ) : null}
      variant="media"
      width={frameWidth}
      height={frameHeight}
      resize={RESIZE}
    >
      <div
        className="contents"
        onDragOver={stopDrag}
        onDrop={(event) => {
          stopDrag(event);
          const file = resolveDroppedVideoFile(event.dataTransfer);
          if (file) void importFile(file);
        }}
      >
        {source ? (
          <video
            src={videoSource ?? undefined}
            poster={posterSource ?? undefined}
            className="nodrag h-full w-full bg-black object-contain"
            controls
            playsInline
            preload="metadata"
          />
        ) : face.kind === 'waiting' ? (
          <button
            type="button"
            className="node-face"
            disabled={!canImport}
            onClick={(event) => {
              if (!canImport) return;
              event.stopPropagation();
              inputRef.current?.click();
            }}
          >
            {isGenerating || isUploading ? <Loader2 className="animate-spin" /> : <Upload />}
            <span>
              {isUploading ? t('node.videoNode.uploading') : isGenerating ? (
                <WaitingLabel
                  startedAt={startedAt}
                  render={(minutes) => (minutes === null
                    ? t('node.videoNode.waitingResult')
                    : t('node.videoNode.waitingResultDelayed', { minutes }))}
                />
              ) : t('node.videoNode.empty')}
            </span>
          </button>
        ) : (
          <ResultProblemFace
            face={face}
            failedTitle={t(uploadError.trim() ? 'node.videoNode.uploadFailed' : 'node.videoNode.generationFailed')}
            action={referenceFailure && !uploadError.trim() ? <GenerationReferenceRetry nodeId={id} failure={referenceFailure} /> : null}
          />
        )}
      </div>
      {isGenerating ? (
        <GenerationProgress
          startedAt={startedAt}
          expectedDurationMs={typeof data.generationDurationMs === 'number' ? data.generationDurationMs : DEFAULT_VIDEO_GENERATION_DURATION_MS}
        />
      ) : null}
      <GenerationJobStatus
        state={isGenerating ? jobState : null}
        phase={data.generationJobPhase}
        networkRoute={data.generationNetworkRoute}
      />
      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = '';
        }}
      />
    </NodeFrame>
  );
});

VideoNode.displayName = 'VideoNode';
