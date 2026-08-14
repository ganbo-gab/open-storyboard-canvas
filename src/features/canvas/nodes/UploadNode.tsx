import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type SyntheticEvent,
} from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  useViewport,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Loader2, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeData,
  type UploadImageNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveMinEdgeFittedSize,
  resolveResizeMinConstraintsByAspect,
} from '@/features/canvas/application/imageNodeSizing';
import {
  isNodeUsingDefaultDisplayName,
  resolveNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
} from '@/features/canvas/application/imageData';
import {
  inferMaterialFileKind,
  isMaterialFile,
  resolveDroppedMaterialFile,
} from '@/features/canvas/application/imageDragDrop';
import { prepareVideoNodeDataFromFile } from '@/features/canvas/application/videoUpload';
import { prepareAudioNodeDataFromFile } from '@/features/canvas/application/audioUpload';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type UploadNodeProps = NodeProps & {
  id: string;
  data: UploadImageNodeData;
  selected?: boolean;
};

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

export const UploadNode = memo(({ id, data, selected, width, height }: UploadNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const replaceNodeType = useCanvasStore((state) => state.replaceNodeType);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const { zoom } = useViewport();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadSequenceRef = useRef(0);
  const uploadPerfRef = useRef<{
    sequence: number;
    name: string;
    size: number;
    startedAt: number;
    transientLoaded: boolean;
    stableLoaded: boolean;
  } | null>(null);
  const [transientPreviewUrl, setTransientPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const resolvedAspectRatio = data.aspectRatio || '1:1';
  const compactSize = resolveMinEdgeFittedSize(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resolvedWidth = resolveNodeDimension(width, compactSize.width);
  const resolvedHeight = resolveNodeDimension(height, compactSize.height);
  const resizeConstraints = resolveResizeMinConstraintsByAspect(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resizeMinWidth = resizeConstraints.minWidth;
  const resizeMinHeight = resizeConstraints.minHeight;
  const resolvedTitle = useMemo(() => {
    const sourceFileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    if (
      useUploadFilenameAsNodeTitle
      && sourceFileName
      && isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.upload, data)
    ) {
      return sourceFileName;
    }

    return resolveNodeDisplayName(CANVAS_NODE_TYPES.upload, data);
  }, [data, useUploadFilenameAsNodeTitle]);

  const clearTransientPreview = useCallback(() => {
    setTransientPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      if (!isMaterialFile(file)) {
        return;
      }

      const selectedFile: File = file;
      const materialKind = inferMaterialFileKind(selectedFile);
      if (!materialKind) {
        return;
      }
      setUploadError('');
      setIsUploading(true);

      if (materialKind === 'video' || materialKind === 'audio') {
        clearTransientPreview();
        try {
          const prepared = materialKind === 'video'
            ? await prepareVideoNodeDataFromFile(selectedFile)
            : await prepareAudioNodeDataFromFile(selectedFile);
          const nextData: Partial<CanvasNodeData> = {
            ...prepared,
          };
          if (useUploadFilenameAsNodeTitle) {
            nextData.displayName = selectedFile.name;
          }
          replaceNodeType(
            id,
            materialKind === 'video' ? CANVAS_NODE_TYPES.video : CANVAS_NODE_TYPES.audio,
            nextData
          );
          setSelectedNode(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setUploadError(message || t('node.upload.uploadFailed'));
          console.error('[UploadNode] failed to import material', {
            id,
            fileName: selectedFile.name,
            fileType: selectedFile.type,
            error,
          });
        } finally {
          setIsUploading(false);
        }
        return;
      }

      if (materialKind !== 'image') {
        setIsUploading(false);
        return;
      }

      const sequence = uploadSequenceRef.current + 1;
      uploadSequenceRef.current = sequence;
      const started = performance.now();
      clearTransientPreview();
      const optimisticPreviewUrl = URL.createObjectURL(selectedFile);
      setTransientPreviewUrl(optimisticPreviewUrl);
      uploadPerfRef.current = {
        sequence,
        name: selectedFile.name,
        size: selectedFile.size,
        startedAt: started,
        transientLoaded: false,
        stableLoaded: false,
      };
      requestAnimationFrame(() => {
        const perf = uploadPerfRef.current;
        if (!perf || perf.sequence !== sequence) {
          return;
        }
        console.info(
          `[upload-perf][e2e] preview-state-committed nodeId=${id} name="${selectedFile.name}" elapsed=${Math.round(performance.now() - started)}ms`
        );
      });

      try {
        const prepared = await prepareNodeImageFromFile(selectedFile);
        const nextData: Partial<UploadImageNodeData> = {
          imageUrl: prepared.imageUrl,
          previewImageUrl: prepared.previewImageUrl,
          aspectRatio: prepared.aspectRatio || '1:1',
          sourceFileName: selectedFile.name,
        };
        if (useUploadFilenameAsNodeTitle) {
          nextData.displayName = selectedFile.name;
        }
        updateNodeData(id, nextData);

        console.info(
          `[upload-perf][node] processFile success nodeId=${id} name="${selectedFile.name}" size=${selectedFile.size}B elapsed=${Math.round(performance.now() - started)}ms`
        );
      } catch (error) {
        if (uploadSequenceRef.current === sequence) {
          clearTransientPreview();
        }
        console.error(
          `[upload-perf][node] processFile failed nodeId=${id} name="${selectedFile.name}" size=${selectedFile.size}B elapsed=${Math.round(performance.now() - started)}ms`,
          error
        );
        const message = error instanceof Error ? error.message : String(error);
        setUploadError(message || t('node.upload.uploadFailed'));
      } finally {
        setIsUploading(false);
      }
    },
    [
      clearTransientPreview,
      id,
      replaceNodeType,
      setSelectedNode,
      t,
      updateNodeData,
      useUploadFilenameAsNodeTitle,
    ]
  );

  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const perf = uploadPerfRef.current;
    if (!perf) {
      return;
    }

    const displayedSrc = event.currentTarget.currentSrc || event.currentTarget.src || '';
    const isTransient = displayedSrc.startsWith('blob:');
    const now = performance.now();

    if (isTransient && !perf.transientLoaded) {
      perf.transientLoaded = true;
      console.info(
        `[upload-perf][e2e] first-visible transient nodeId=${id} name="${perf.name}" size=${perf.size}B elapsed=${Math.round(now - perf.startedAt)}ms`
      );
      requestAnimationFrame(() => {
        const nextPerf = uploadPerfRef.current;
        if (!nextPerf || nextPerf.sequence !== perf.sequence) {
          return;
        }
        console.info(
          `[upload-perf][e2e] first-painted transient nodeId=${id} name="${nextPerf.name}" elapsed=${Math.round(performance.now() - nextPerf.startedAt)}ms`
        );
      });
      return;
    }

    if (!isTransient && !perf.stableLoaded) {
      perf.stableLoaded = true;
      console.info(
        `[upload-perf][e2e] stable-visible nodeId=${id} name="${perf.name}" size=${perf.size}B elapsed=${Math.round(now - perf.startedAt)}ms`
      );
      if (uploadSequenceRef.current === perf.sequence) {
        clearTransientPreview();
      }
      requestAnimationFrame(() => {
        const nextPerf = uploadPerfRef.current;
        if (!nextPerf || nextPerf.sequence !== perf.sequence) {
          return;
        }
        console.info(
          `[upload-perf][e2e] stable-painted nodeId=${id} name="${nextPerf.name}" elapsed=${Math.round(performance.now() - nextPerf.startedAt)}ms`
        );
      });
    }
  }, [clearTransientPreview, id]);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const file = resolveDroppedMaterialFile(event.dataTransfer);
      if (!file) {
        return;
      }

      await processFile(file);
    },
    [processFile]
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!isMaterialFile(file)) {
        return;
      }

      await processFile(file);
      event.target.value = '';
    },
    [processFile]
  );

  useEffect(() => {
    return canvasEventBus.subscribe('upload-node/reupload', ({ nodeId }) => {
      if (nodeId !== id) {
        return;
      }
      inputRef.current?.click();
    });
  }, [id]);

  useEffect(() => {
    return canvasEventBus.subscribe('upload-node/paste-material', ({ nodeId, file }) => {
      if (nodeId !== id || !isMaterialFile(file)) {
        return;
      }
      void processFile(file);
    });
  }, [id, processFile]);

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
    if (!data.imageUrl && !transientPreviewUrl && !isUploading) {
      inputRef.current?.click();
    }
  }, [data.imageUrl, id, isUploading, setSelectedNode, transientPreviewUrl]);

  useEffect(() => () => {
    uploadPerfRef.current = null;
    clearTransientPreview();
  }, [clearTransientPreview]);

  const imageSource = useMemo(() => {
    if (transientPreviewUrl) {
      return transientPreviewUrl;
    }
    const preferOriginal = shouldUseOriginalImageByZoom(zoom);
    const picked = preferOriginal
      ? data.imageUrl || data.previewImageUrl
      : data.previewImageUrl || data.imageUrl;
    return picked ? resolveImageDisplayUrl(picked) : null;
  }, [data.imageUrl, data.previewImageUrl, transientPreviewUrl, zoom]);

  const imageFallbackSources = useMemo(() => {
    const sources = [data.imageUrl, data.previewImageUrl]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => resolveImageDisplayUrl(item));
    return transientPreviewUrl
      ? [transientPreviewUrl, ...Array.from(new Set(sources))]
      : Array.from(new Set(sources));
  }, [data.imageUrl, data.previewImageUrl, transientPreviewUrl]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-0 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={handleNodeClick}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Upload className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      {data.imageUrl || transientPreviewUrl ? (
        <div className="relative block h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-[var(--canvas-node-media-bg)]">
          <CanvasNodeImage
            src={imageSource ?? ''}
            fallbackSrcs={imageFallbackSources}
            viewerSourceUrl={data.imageUrl ? resolveImageDisplayUrl(data.imageUrl) : null}
            alt={t('node.upload.uploadedAlt')}
            className="h-full w-full object-contain"
            onLoad={handleImageLoad}
          />
          {/* Reupload button on left side */}
          <button
            type="button"
            className="absolute left-2 top-2 flex h-7 items-center gap-1 rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] px-2 text-xs text-text-dark shadow-sm backdrop-blur-sm transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            <RefreshCw className="h-3 w-3" />
            {t('nodeToolbar.reupload')}
          </button>
        </div>
      ) : uploadError ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[var(--node-radius)] bg-red-500/[0.10] px-4 text-red-800 dark:bg-[rgba(127,29,29,0.16)] dark:text-red-200">
          <AlertTriangle className="h-7 w-7 opacity-90" />
          <span className="text-center text-[12px] font-medium leading-5">
            {t('node.upload.uploadFailed')}
          </span>
          <span className="max-h-[76px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-800/90 dark:text-red-200/90">
            {uploadError}
          </span>
        </div>
      ) : (
        <label
          className="block h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-[var(--canvas-node-media-bg)]"
        >
          <div className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-text-muted/85">
            {isUploading ? (
              <Loader2 className="h-7 w-7 animate-spin opacity-70" />
            ) : (
              <Upload className="h-7 w-7 opacity-60" />
            )}
            <span className="px-3 text-center text-[12px] leading-6">
              {isUploading ? t('node.upload.uploading') : t('node.upload.hint')}
            </span>
          </div>
        </label>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={resizeMinWidth}
        minHeight={resizeMinHeight}
        maxWidth={1400}
        maxHeight={1400}
      />
    </div>
  );
});

UploadNode.displayName = 'UploadNode';
