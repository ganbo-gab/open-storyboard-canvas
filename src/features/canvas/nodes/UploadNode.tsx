import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, ImageUp, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeData,
  type UploadImageNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveMinEdgeFittedSize, resolveResizeMinConstraintsByAspect } from '@/features/canvas/application/imageNodeSizing';
import { isNodeUsingDefaultDisplayName, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { loadImageElement, prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import { useCanvasImageThumbnail } from '@/features/canvas/application/useCanvasImageThumbnail';
import { inferMaterialFileKind, isMaterialFile, resolveDroppedMaterialFile } from '@/features/canvas/application/imageDragDrop';
import { prepareVideoNodeDataFromFile } from '@/features/canvas/application/videoUpload';
import { prepareAudioNodeDataFromFile } from '@/features/canvas/application/audioUpload';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { NodeFrame } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type UploadNodeProps = NodeProps & {
  id: string;
  data: UploadImageNodeData;
  selected?: boolean;
};

const LIMITS = { minWidth: EXPORT_RESULT_NODE_MIN_WIDTH, minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT };

/**
 * Material slot: click, drop or paste an image, video or audio file. Video and audio turn the
 * node into the matching media node (same id, so connections survive).
 */
export const UploadNode = memo(({ id, data, selected = false, width, height }: UploadNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const replaceNodeType = useCanvasStore((state) => state.replaceNodeType);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const useFileNameAsTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);
  // Object URL of the picked file, shown instantly until the stored copy has loaded.
  const [instantPreview, setInstantPreview] = useState<string | null>(null);
  const instantPreviewRef = useRef<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const aspectRatio = data.aspectRatio || '1:1';
  const compactSize = resolveMinEdgeFittedSize(aspectRatio, LIMITS);
  const resizeMin = resolveResizeMinConstraintsByAspect(aspectRatio, LIMITS);
  const frameWidth = typeof width === 'number' && width > 1 ? Math.round(width) : compactSize.width;
  const frameHeight = typeof height === 'number' && height > 1 ? Math.round(height) : compactSize.height;
  const title = useMemo(() => {
    const fileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    return useFileNameAsTitle && fileName && isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.upload, data)
      ? fileName
      : resolveNodeDisplayName(CANVAS_NODE_TYPES.upload, data);
  }, [data, useFileNameAsTitle]);

  const dropInstantPreview = useCallback(() => {
    if (instantPreviewRef.current) URL.revokeObjectURL(instantPreviewRef.current);
    instantPreviewRef.current = null;
    setInstantPreview(null);
  }, []);

  const importFile = useCallback(async (file: File) => {
    const kind = isMaterialFile(file) ? inferMaterialFileKind(file) : null;
    if (!kind) return;
    setUploadError('');
    setIsUploading(true);
    dropInstantPreview();
    const sequence = ++uploadSequence.current;
    try {
      if (kind === 'video' || kind === 'audio') {
        const prepared = kind === 'video' ? await prepareVideoNodeDataFromFile(file) : await prepareAudioNodeDataFromFile(file);
        if (uploadSequence.current !== sequence) return;
        const nextData: Partial<CanvasNodeData> = useFileNameAsTitle ? { ...prepared, displayName: file.name } : prepared;
        replaceNodeType(id, kind === 'video' ? CANVAS_NODE_TYPES.video : CANVAS_NODE_TYPES.audio, nextData);
        setSelectedNode(id);
        return;
      }
      if (kind !== 'image') return;
      const localPreview = URL.createObjectURL(file);
      instantPreviewRef.current = localPreview;
      setInstantPreview(localPreview);
      const prepared = await prepareNodeImageFromFile(file);
      if (uploadSequence.current !== sequence) return;
      updateNodeData(id, {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio || '1:1',
        sourceFileName: file.name,
        ...(useFileNameAsTitle ? { displayName: file.name } : {}),
      });
    } catch (error) {
      console.error('[UploadNode] failed to import material', { id, fileName: file.name, fileType: file.type, error });
      if (uploadSequence.current === sequence) {
        dropInstantPreview();
        setUploadError((error instanceof Error ? error.message : String(error)) || t('node.upload.uploadFailed'));
      }
    } finally {
      if (uploadSequence.current === sequence) setIsUploading(false);
    }
  }, [dropInstantPreview, id, replaceNodeType, setSelectedNode, t, updateNodeData, useFileNameAsTitle]);

  useEffect(() => canvasEventBus.subscribe('upload-node/reupload', ({ nodeId }) => {
    if (nodeId === id) inputRef.current?.click();
  }), [id]);

  useEffect(() => canvasEventBus.subscribe('upload-node/paste-material', ({ nodeId, file }) => {
    if (nodeId === id) void importFile(file);
  }), [id, importFile]);

  useEffect(() => dropInstantPreview, [dropInstantPreview]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, frameHeight, frameWidth, updateNodeInternals]);

  const image = useCanvasImageThumbnail({
    imageUrl: data.imageUrl,
    previewImageUrl: data.previewImageUrl,
    width: frameWidth,
    height: frameHeight,
  });
  useEffect(() => {
    if (!instantPreview || isUploading || image.pending || !image.src || image.src === instantPreview) return;
    let cancelled = false;
    const sequence = uploadSequence.current;
    // Decode the small prepared display before revoking the temporary full-resolution upload.
    void loadImageElement(image.src).then(async (prepared) => {
      await prepared.decode();
      if (!cancelled && uploadSequence.current === sequence) dropInstantPreview();
    }).catch((error: unknown) => {
      if (!cancelled) console.warn('[UploadNode] prepared display is not ready; retaining local preview', { error });
    });
    return () => { cancelled = true; };
  }, [dropInstantPreview, image.pending, image.src, instantPreview, isUploading]);
  const hasImage = Boolean(data.imageUrl || instantPreview);
  const pick = () => inputRef.current?.click();
  const stopDrag = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <NodeFrame
      type={CANVAS_NODE_TYPES.upload}
      selected={selected}
      icon={<ImageUp />}
      title={title}
      onRename={(displayName) => updateNodeData(id, { displayName })}
      meta={data.imageUrl ? aspectRatio : undefined}
      status={uploadError ? { kind: 'error', label: t('node.upload.uploadFailed') } : null}
      actions={hasImage ? (
        <button
          type="button"
          className="nodrag"
          aria-label={t('nodeToolbar.reupload')}
          title={t('nodeToolbar.reupload')}
          onClick={(event) => {
            event.stopPropagation();
            pick();
          }}
        >
          <RefreshCw />
        </button>
      ) : null}
      variant="media"
      width={frameWidth}
      height={frameHeight}
      resize={{ minWidth: resizeMin.minWidth, minHeight: resizeMin.minHeight, maxWidth: 1400, maxHeight: 1400, keepAspectRatio: hasImage }}
    >
      <div
        className="contents"
        onDragOver={stopDrag}
        onDrop={(event) => {
          stopDrag(event);
          const file = resolveDroppedMaterialFile(event.dataTransfer);
          if (file) void importFile(file);
        }}
      >
        {hasImage ? (
          <CanvasNodeImage
            src={instantPreview ?? image.src}
            fallbackSrcs={instantPreview ? [instantPreview, ...image.fallbackSrcs] : image.fallbackSrcs}
            pending={!instantPreview && image.pending}
            viewerSourceUrl={image.viewerSrc || null}
            alt={t('node.upload.uploadedAlt')}
            className="h-full w-full object-contain"
          />
        ) : uploadError ? (
          <button type="button" className="node-face" data-tone="error" onClick={(event) => { event.stopPropagation(); pick(); }}>
            <AlertTriangle />
            <strong>{t('node.upload.uploadFailed')}</strong>
            <span className="node-face__detail">{uploadError}</span>
          </button>
        ) : (
          <button
            type="button"
            className="node-face node-face--drop"
            disabled={isUploading}
            onClick={(event) => {
              event.stopPropagation();
              pick();
            }}
          >
            {isUploading ? <Loader2 className="animate-spin" /> : <ImageUp />}
            <span>{isUploading ? t('node.upload.uploading') : t('node.upload.hint')}</span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
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

UploadNode.displayName = 'UploadNode';
