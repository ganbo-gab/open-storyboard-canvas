import {
  memo,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  useViewport,
  type NodeProps,
} from '@xyflow/react';
import { Download, FolderOpen, ImagePlus, SlidersHorizontal, SquareArrowOutUpRight } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { join } from '@tauri-apps/api/path';

import {
  embedStoryboardImageMetadata,
  mergeStoryboardImages,
  saveImageSourceToDirectory,
  type MergeStoryboardImagesResult,
} from '@/commands/image';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import type {
  StoryboardExportOptions,
  StoryboardFrameItem,
  StoryboardSplitNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasToDataUrl,
  loadImageElement,
  prepareNodeImage,
  persistImageLocally,
  reduceAspectRatio,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
} from '@/features/canvas/application/imageData';
import {
  parseInputImageRefsSignature,
  selectInputImageRefsSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import { UiButton, UiCheckbox, UiChipButton, UiInput, UiPanel, UiSelect } from '@/components/ui';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';

type StoryboardNodeProps = NodeProps & {
  id: string;
  data: StoryboardSplitNodeData;
  selected?: boolean;
};

const STORYBOARD_NODE_WIDTH_PX = 318;
const STORYBOARD_NODE_MIN_HEIGHT_PX = 320;
const STORYBOARD_GRID_GAP_PX = 1;
const EXPORT_MAX_DIMENSION = 4096;
const EXPORT_TRACE_PREFIX = '[StoryboardExport]';
const STORYBOARD_SPLIT_HEADER_ADJUST = { x: 0, y: 0, scale: 1 };
const STORYBOARD_SPLIT_ICON_ADJUST = { x: 0, y: 0, scale: 1 };
const STORYBOARD_SPLIT_TITLE_ADJUST = { x: 0, y: 0, scale: 1 };

function SplitResultIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 0c1.66 0 3 1.34 3 3v3l2.4-1.5a3.003 3.003 0 0 1 3 5.2a3.003 3.003 0 0 1-4.452-2.051l-.952.55v6.8h-2v-5.65l-4.01 2.32l-.988-1.73l5-2.94v-1.17a2.996 2.996 0 0 1-4-2.829c0-1.66 1.34-3 3-3zM9 3a1 1 0 0 0 2 0a1 1 0 0 0-2 0m7 4a1 1 0 0 0 2 0a1 1 0 0 0-2 0M2.97 19h2v-2h-2V9h3V7h-3c-1.1 0-2 .895-2 2v8c0 1.1.895 2 2 2m6 0h-2v-2h2zm4-2c0 1.1-.895 2-2 2v-2z" />
    </svg>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePathSegment(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const sanitized = Array.from(trimmed)
    .filter((ch) => !/[<>:"/\\|?*]/.test(ch) && ch >= ' ')
    .join('')
    .trim()
    .replace(/\.+$/g, '');

  return sanitized || fallback;
}

function sanitizeExportLabel(raw: string, maxLength = 50): string {
  const compact = sanitizePathSegment(raw, '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.slice(0, maxLength);
}

function toCssAspectRatio(aspectRatio: string): string {
  const [rawWidth = '1', rawHeight = '1'] = aspectRatio.split(':');
  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1 / 1';
  }

  return `${width} / ${height}`;
}

function createDefaultExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

function resolveExportOptions(options: StoryboardSplitNodeData['exportOptions']): StoryboardExportOptions {
  const merged = {
    ...createDefaultExportOptions(),
    ...(options ?? {}),
  };

  const rawFontSize = Number.isFinite(merged.fontSize) ? merged.fontSize : 4;
  const normalizedFontPercent = rawFontSize > 20
    ? Math.round(rawFontSize / 6)
    : rawFontSize;

  return {
    ...merged,
    fontSize: clamp(Math.round(normalizedFontPercent), 1, 20),
  };
}

function trimTextToWidth(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  const safeText = text.trim();
  if (!safeText) {
    return '';
  }

  if (context.measureText(safeText).width <= maxWidth) {
    return safeText;
  }

  let content = safeText;
  while (content.length > 1) {
    content = content.slice(0, -1);
    const withEllipsis = `${content}...`;
    if (context.measureText(withEllipsis).width <= maxWidth) {
      return withEllipsis;
    }
  }

  return '...';
}

async function applyStoryboardTextOverlay(
  imageSource: string,
  frames: StoryboardFrameItem[],
  options: StoryboardExportOptions,
  rows: number,
  cols: number,
  layout: MergeStoryboardImagesResult
): Promise<string> {
  if (!options.showFrameIndex && !options.showFrameNote) {
    return imageSource;
  }

  const image = await loadImageElement(imageSource);
  const canvas = document.createElement('canvas');
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('导出画布初始化失败');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.font = `${Math.max(500, Math.round(layout.fontSize * 1.2))} ${layout.fontSize}px sans-serif`;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const row = Math.floor(index / Math.max(1, cols));
    const col = index % Math.max(1, cols);
    if (row >= rows) {
      break;
    }

    const x = layout.padding + col * (layout.cellWidth + layout.gap);
    const y = layout.padding + row * (layout.cellHeight + layout.noteHeight + layout.gap);

    if (options.showFrameIndex) {
      const label = `${options.frameIndexPrefix || 'S'}${index + 1}`;
      const badgePaddingX = Math.max(6, Math.round(layout.fontSize * 0.35));
      const badgeHeight = Math.max(18, Math.round(layout.fontSize * 1.15));
      const textWidth = context.measureText(label).width;
      const badgeWidth = Math.round(textWidth + badgePaddingX * 2);

      context.fillStyle = 'rgba(0,0,0,0.65)';
      context.fillRect(x + 6, y + 6, badgeWidth, badgeHeight);
      context.fillStyle = options.textColor;
      context.fillText(label, x + 6 + badgePaddingX, y + 6 + badgeHeight / 2);
    }

    if (options.showFrameNote) {
      const note = trimTextToWidth(
        context,
        frame.note || '',
        Math.max(20, layout.cellWidth - 14)
      );

      if (!note) {
        continue;
      }

      if (options.notePlacement === 'overlay') {
        const overlayHeight = Math.max(18, Math.round(layout.fontSize * 1.35));
        const overlayY = y + layout.cellHeight - overlayHeight;
        context.fillStyle = 'rgba(0, 0, 0, 0.6)';
        context.fillRect(x, overlayY, layout.cellWidth, overlayHeight);
        context.fillStyle = options.textColor;
        context.fillText(note, x + 7, overlayY + overlayHeight / 2);
      } else if (layout.noteHeight > 0) {
        const noteY = y + layout.cellHeight + layout.noteHeight / 2;
        context.fillStyle = options.textColor;
        context.fillText(note, x + 4, noteY);
      }
    }
  }

  return canvasToDataUrl(canvas);
}

interface FrameCardProps {
  nodeId: string;
  frame: StoryboardFrameItem;
  index: number;
  frameAspectRatioCss: string;
  imageFit: StoryboardExportOptions['imageFit'];
  viewerImageList: string[];
  draggedFrameId: string | null;
  dropTargetFrameId: string | null;
  onSortStart: (frameId: string) => void;
  onSortHover: (frameId: string) => void;
  onTogglePicker: (frameId: string, x: number, y: number) => void;
  onEditFrame: (frame: StoryboardFrameItem) => void;
}

interface IncomingImageItem {
  imageUrl: string;
  previewImageUrl: string | null;
  displayUrl: string;
  label: string;
}

interface PanelAnchor {
  left: number;
  top: number;
}

const FrameCard = memo(
  ({
    nodeId,
    frame,
    index,
    frameAspectRatioCss,
    imageFit,
    viewerImageList,
    draggedFrameId,
    dropTargetFrameId,
    onSortStart,
    onSortHover,
    onTogglePicker,
    onEditFrame,
  }: FrameCardProps) => {
    const updateStoryboardFrame = useCanvasStore((state) => state.updateStoryboardFrame);
    const { zoom } = useViewport();

    const imageSource = useMemo(() => {
      const preferOriginal = shouldUseOriginalImageByZoom(zoom);
      const picked = preferOriginal
        ? frame.imageUrl || frame.previewImageUrl
        : frame.previewImageUrl || frame.imageUrl;
      return picked ? resolveImageDisplayUrl(picked) : null;
    }, [frame.imageUrl, frame.previewImageUrl, zoom]);
    const viewerSource = useMemo(() => {
      const picked = frame.imageUrl || frame.previewImageUrl;
      return picked ? resolveImageDisplayUrl(picked) : null;
    }, [frame.imageUrl, frame.previewImageUrl]);

    const dragging = draggedFrameId === frame.id;
    const asDropTarget = dropTargetFrameId === frame.id && !dragging;

    return (
      <div
        onPointerEnter={(event) => {
          event.stopPropagation();
          onSortHover(frame.id);
        }}
        onPointerMove={(event) => {
          event.stopPropagation();
          onSortHover(frame.id);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className={`nodrag relative bg-bg-dark/85 transition-colors ${dragging
          ? 'z-10 opacity-55 ring-1 ring-accent/65'
          : asDropTarget
            ? 'z-10 ring-1 ring-emerald-400/70'
            : ''
          }`}
      >
        <div
          className={`group/frame relative overflow-hidden bg-surface-dark ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ aspectRatio: frameAspectRatioCss }}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onSortStart(frame.id);
          }}
        >
          {frame.imageUrl ? (
            <CanvasNodeImage
              src={imageSource ?? ''}
              alt={`Frame ${index + 1}`}
              viewerSourceUrl={viewerSource}
              viewerImageList={viewerImageList}
              className={`h-full w-full ${imageFit === 'contain' ? 'object-contain' : 'object-cover'}`}
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-text-muted">
              空分镜
            </div>
          )}

          <button
            type="button"
            className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition-all duration-150 hover:bg-black/75 group-hover/frame:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onEditFrame(frame);
            }}
            title="单独编辑此格"
          >
            <SquareArrowOutUpRight className="h-3 w-3" />
          </button>

          <button
            type="button"
            className="absolute bottom-1 right-1 rounded bg-black/60 p-1 text-white opacity-0 transition-all duration-150 hover:bg-black/75 group-hover/frame:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePicker(frame.id, event.clientX, event.clientY);
            }}
            title="从输入图片替换"
          >
            <ImagePlus className="h-3 w-3" />
          </button>
        </div>

        <textarea
          value={frame.note}
          onChange={(event) => {
            const nextValue = event.target.value;
            updateStoryboardFrame(nodeId, frame.id, {
              note: nextValue,
            });
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
          placeholder={`分镜 ${String(index + 1).padStart(2, '0')} 描述`}
          className="ui-scrollbar nodrag nowheel h-10 w-full resize-none overflow-y-auto border-0 border-t border-[rgba(255,255,255,0.12)] bg-bg-dark/90 px-2 py-1 text-[10px] text-text-dark outline-none focus:border-accent"
        />
      </div>
    );
  }
);

FrameCard.displayName = 'FrameCard';

export const StoryboardNode = memo(({ id, data, selected, width, height }: StoryboardNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerMenuRef = useRef<HTMLDivElement>(null);
  const exportSettingsTriggerRef = useRef<HTMLDivElement>(null);
  const exportSettingsPanelRef = useRef<HTMLDivElement>(null);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const incomingImageRefsSignature = useCanvasStore((state) =>
    selectInputImageRefsSignature(id, state.nodes, state.edges)
  );
  const reorderStoryboardFrame = useCanvasStore((state) => state.reorderStoryboardFrame);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateStoryboardFrame = useCanvasStore((state) => state.updateStoryboardFrame);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const currentProjectName = useProjectStore((state) => state.currentProject?.name);
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);

  const [draggedFrameId, setDraggedFrameId] = useState<string | null>(null);
  const [dropTargetFrameId, setDropTargetFrameId] = useState<string | null>(null);
  const [pickerState, setPickerState] = useState<{ frameId: string; x: number; y: number } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isPackingSingleImages, setIsPackingSingleImages] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExportPanelOpen, setIsExportPanelOpen] = useState(false);
  const [isExportPanelVisible, setIsExportPanelVisible] = useState(false);
  const [exportPanelAnchor, setExportPanelAnchor] = useState<PanelAnchor | null>(null);
  const [isPackDoneDialogOpen, setIsPackDoneDialogOpen] = useState(false);
  const [packOutputDir, setPackOutputDir] = useState<string>('');
  const [packRevealFilePath, setPackRevealFilePath] = useState<string>('');

  const orderedFrames = useMemo(
    () => [...data.frames].sort((a, b) => a.order - b.order),
    [data.frames]
  );

  const frameAspectRatio = useMemo(() => {
    return (
      data.frameAspectRatio ??
      orderedFrames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      '1:1'
    );
  }, [data.frameAspectRatio, orderedFrames]);

  const frameAspectRatioCss = useMemo(
    () => toCssAspectRatio(frameAspectRatio),
    [frameAspectRatio]
  );

  const gridCols = Math.max(1, data.gridCols);
  const gridRows = Math.max(1, data.gridRows);
  const totalFrames = orderedFrames.length;
  const resolvedNodeWidth = Math.max(STORYBOARD_NODE_WIDTH_PX, Math.round(width ?? STORYBOARD_NODE_WIDTH_PX));
  const resolvedNodeHeight = Math.max(
    STORYBOARD_NODE_MIN_HEIGHT_PX,
    Math.round(height ?? STORYBOARD_NODE_MIN_HEIGHT_PX)
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedNodeHeight, resolvedNodeWidth, updateNodeInternals]);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.storyboardSplit, data),
    [data]
  );

  const exportOptions = useMemo(
    () => resolveExportOptions(data.exportOptions),
    [data.exportOptions]
  );

  const incomingImageRefs = useMemo(() => {
    return parseInputImageRefsSignature(incomingImageRefsSignature);
  }, [incomingImageRefsSignature]);

  const incomingImageItems = useMemo<IncomingImageItem[]>(
    () =>
      incomingImageRefs.map((item, index) => ({
        imageUrl: item.imageUrl,
        previewImageUrl: item.previewImageUrl,
        displayUrl: resolveImageDisplayUrl(item.previewImageUrl || item.imageUrl),
        label: `图${index + 1}`,
      })),
    [incomingImageRefs]
  );
  const frameViewerImageList = useMemo(
    () =>
      orderedFrames
        .map((frame) => {
          const source = frame.imageUrl || frame.previewImageUrl;
          return source ? resolveImageDisplayUrl(source) : null;
        })
        .filter((item): item is string => Boolean(item)),
    [orderedFrames]
  );
  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems]
  );

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!rootRef.current) {
        return;
      }

      const target = event.target as Node;
      const insideRoot = rootRef.current.contains(target);
      const insidePickerMenu = pickerMenuRef.current?.contains(target) ?? false;
      const insideExportPanel = exportSettingsPanelRef.current?.contains(target) ?? false;
      const insideExportTrigger = exportSettingsTriggerRef.current?.contains(target) ?? false;

      if (!insideRoot && !insidePickerMenu) {
        setPickerState(null);
      }

      if (!insideExportPanel && !insideExportTrigger) {
        setIsExportPanelOpen(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, []);

  useEffect(() => {
    if (!isExportPanelOpen) {
      setIsExportPanelVisible(false);
      return;
    }

    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setIsExportPanelVisible(true);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) {
        cancelAnimationFrame(raf2);
      }
    };
  }, [isExportPanelOpen]);

  const getPanelAnchor = useCallback((triggerElement: HTMLDivElement | null): PanelAnchor | null => {
    if (!triggerElement) {
      return null;
    }
    const rect = triggerElement.getBoundingClientRect();
    return {
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
    };
  }, []);

  const patchExportOptions = useCallback(
    (patch: Partial<StoryboardExportOptions>) => {
      updateNodeData(id, {
        exportOptions: {
          ...exportOptions,
          ...patch,
        },
      });
    },
    [exportOptions, id, updateNodeData]
  );

  const handleSortStart = useCallback((frameId: string) => {
    setDraggedFrameId(frameId);
    setDropTargetFrameId(frameId);
    setPickerState(null);
  }, []);

  const handleSortHover = useCallback(
    (frameId: string) => {
      if (!draggedFrameId) {
        return;
      }
      setDropTargetFrameId(frameId);
    },
    [draggedFrameId]
  );

  const finalizeSort = useCallback(() => {
    if (!draggedFrameId) {
      return;
    }

    if (dropTargetFrameId && dropTargetFrameId !== draggedFrameId) {
      reorderStoryboardFrame(id, draggedFrameId, dropTargetFrameId);
    }

    setDraggedFrameId(null);
    setDropTargetFrameId(null);
  }, [draggedFrameId, dropTargetFrameId, id, reorderStoryboardFrame]);

  useEffect(() => {
    if (!draggedFrameId) {
      return;
    }

    const handlePointerUp = () => {
      finalizeSort();
    };

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [draggedFrameId, finalizeSort]);

  const handleEditFrame = useCallback(
    async (frame: StoryboardFrameItem) => {
      try {
        const sourceImage = frame.imageUrl ?? frame.previewImageUrl;
        if (!sourceImage) {
          setExportError('该分镜没有可编辑图片');
          return;
        }
        const frameIndex = orderedFrames.findIndex((item) => item.id === frame.id);
        const frameTitle = frameIndex >= 0
          ? `分镜 ${frameIndex + 1}`
          : EXPORT_RESULT_DISPLAY_NAME.storyboardFrameEdit;

        const prepared = await prepareNodeImage(sourceImage);
        const createdNodeId = addDerivedExportNode(
          id,
          prepared.imageUrl,
          prepared.aspectRatio,
          prepared.previewImageUrl,
          {
            defaultTitle: frameTitle,
            resultKind: 'storyboardFrameEdit',
          }
        );

        if (createdNodeId) {
          addEdge(id, createdNodeId);
        }
      } catch (error) {
        setExportError(error instanceof Error ? error.message : '创建编辑节点失败');
      }
    },
    [addDerivedExportNode, addEdge, id, orderedFrames]
  );

  const handleExport = useCallback(async () => {
    if (isExporting) {
      return;
    }

    const traceId = `${id}-${Date.now()}`;
    const traceStart = performance.now();
    console.info(`${EXPORT_TRACE_PREFIX} start`, {
      traceId,
      nodeId: id,
      rows: gridRows,
      cols: gridCols,
      frameCount: orderedFrames.length,
    });

    setIsExporting(true);
    setExportError(null);

    try {
      const stageFrameStart = performance.now();
      const frameSources = orderedFrames.map(
        (frame) => frame.imageUrl ?? frame.previewImageUrl ?? ''
      );
      if (frameSources.every((source) => !source)) {
        throw new Error('没有可导出的图片');
      }
      console.info(`${EXPORT_TRACE_PREFIX} frame-sources-ready`, {
        traceId,
        elapsedMs: Math.round(performance.now() - stageFrameStart),
        nonEmptyFrames: frameSources.filter((source) => source.length > 0).length,
      });

      const options = exportOptions;
      const rawGap = clamp(Math.round(options.cellGap), 0, 120);
      const rawPadding = 0;
      const fontPercent = clamp(Number.isFinite(options.fontSize) ? options.fontSize : 4, 1, 20);
      const firstFrameSource = frameSources.find((source) => source.length > 0) ?? null;
      let referenceFrameHeight = 1024;
      if (firstFrameSource) {
        const fontProbeStart = performance.now();
        try {
          const referenceImage = await loadImageElement(firstFrameSource);
          referenceFrameHeight = Math.max(
            64,
            referenceImage.naturalHeight || referenceImage.height || referenceFrameHeight
          );
        } catch {
          // Keep fallback size when reference frame cannot be read.
        }
        console.info(`${EXPORT_TRACE_PREFIX} font-reference-resolved`, {
          traceId,
          elapsedMs: Math.round(performance.now() - fontProbeStart),
          referenceFrameHeight,
        });
      }
      const rawFontSize = clamp(
        Math.round(referenceFrameHeight * (fontPercent / 100)),
        10,
        240
      );
      const rawNoteHeight =
        options.showFrameNote && options.notePlacement === 'bottom'
          ? Math.max(Math.round(rawFontSize * 1.7), 24)
          : 0;

      const mergeStart = performance.now();
      const mergeResult = await mergeStoryboardImages({
        frameSources,
        rows: gridRows,
        cols: gridCols,
        cellGap: rawGap,
        outerPadding: rawPadding,
        noteHeight: rawNoteHeight,
        fontSize: rawFontSize,
        backgroundColor: options.backgroundColor,
        maxDimension: EXPORT_MAX_DIMENSION,
        showFrameIndex: options.showFrameIndex,
        showFrameNote: options.showFrameNote,
        notePlacement: options.notePlacement,
        imageFit: options.imageFit,
        frameIndexPrefix: options.frameIndexPrefix,
        textColor: options.textColor,
        frameNotes: orderedFrames.map((frame) => frame.note ?? ''),
      });
      console.info(`${EXPORT_TRACE_PREFIX} merge-done`, {
        traceId,
        elapsedMs: Math.round(performance.now() - mergeStart),
        canvasWidth: mergeResult.canvasWidth,
        canvasHeight: mergeResult.canvasHeight,
        textOverlayApplied: mergeResult.textOverlayApplied,
      });

      const aspectRatio = reduceAspectRatio(mergeResult.canvasWidth, mergeResult.canvasHeight);
      const needsOverlay = (options.showFrameIndex || options.showFrameNote) && !mergeResult.textOverlayApplied;
      let finalImagePath = mergeResult.imagePath;
      let finalPreviewPath = mergeResult.imagePath;

      if (needsOverlay) {
        const overlayStart = performance.now();
        const mergedBlob = await applyStoryboardTextOverlay(
          mergeResult.imagePath,
          orderedFrames,
          options,
          gridRows,
          gridCols,
          mergeResult
        );
        console.info(`${EXPORT_TRACE_PREFIX} overlay-done`, {
          traceId,
          elapsedMs: Math.round(performance.now() - overlayStart),
          dataUrlLength: mergedBlob.length,
        });
        const persistStart = performance.now();
        finalImagePath = await persistImageLocally(mergedBlob);
        finalPreviewPath = finalImagePath;
        console.info(`${EXPORT_TRACE_PREFIX} overlay-persisted`, {
          traceId,
          elapsedMs: Math.round(performance.now() - persistStart),
          persistedPath: finalImagePath,
        });
      }

      const metadataStart = performance.now();
      const metadataFrameNotes = orderedFrames.map((frame) => frame.note ?? '');
      const imagePathWithMetadata = await embedStoryboardImageMetadata(finalImagePath, {
        gridRows,
        gridCols,
        frameNotes: metadataFrameNotes,
      }).catch((error) => {
        console.warn('[StoryboardMetadata] embed failed on storyboard export', error);
        return finalImagePath;
      });
      finalImagePath = imagePathWithMetadata;
      finalPreviewPath = imagePathWithMetadata;
      console.info(`${EXPORT_TRACE_PREFIX} metadata-embedded`, {
        traceId,
        elapsedMs: Math.round(performance.now() - metadataStart),
        imagePath: finalImagePath,
      });

      const createNodeStart = performance.now();
      const createdNodeId = addDerivedExportNode(
        id,
        finalImagePath,
        aspectRatio,
        finalPreviewPath,
        {
          defaultTitle: EXPORT_RESULT_DISPLAY_NAME.storyboardSplitExport,
          resultKind: 'storyboardSplitExport',
        }
      );
      console.info(`${EXPORT_TRACE_PREFIX} derived-node-created`, {
        traceId,
        elapsedMs: Math.round(performance.now() - createNodeStart),
        createdNodeId,
      });

      if (createdNodeId) {
        addEdge(id, createdNodeId);
      }
      console.info(`${EXPORT_TRACE_PREFIX} done`, {
        traceId,
        totalElapsedMs: Math.round(performance.now() - traceStart),
      });
    } catch (error) {
      console.error(`${EXPORT_TRACE_PREFIX} failed`, {
        traceId,
        elapsedMs: Math.round(performance.now() - traceStart),
        error,
      });
      setExportError(error instanceof Error ? error.message : '导出失败');
    } finally {
      setIsExporting(false);
    }
  }, [
    addDerivedExportNode,
    addEdge,
    exportOptions,
    gridCols,
    gridRows,
    id,
    isExporting,
    orderedFrames,
  ]);

  const resolvePackRootDir = useCallback(async (): Promise<string | null> => {
    const presetPath = downloadPresetPaths.find((path) => path.trim().length > 0)?.trim() ?? '';
    if (presetPath) {
      return presetPath;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择分镜导出文件夹',
    });
    if (!selected || Array.isArray(selected)) {
      return null;
    }

    return selected;
  }, [downloadPresetPaths]);

  const handlePackSingleImages = useCallback(async () => {
    if (isExporting || isPackingSingleImages) {
      return;
    }

    setExportError(null);
    setIsPackingSingleImages(true);

    try {
      const frameEntries = orderedFrames
        .map((frame, index) => ({
          source: frame.imageUrl ?? frame.previewImageUrl ?? '',
          index,
          note: frame.note ?? '',
        }))
        .filter((item) => item.source.length > 0);

      if (frameEntries.length === 0) {
        throw new Error('该分镜没有可导出的图片');
      }

      const rootDir = await resolvePackRootDir();
      if (!rootDir) {
        return;
      }

      const normalizedProjectName = sanitizePathSegment(currentProjectName ?? '', '未命名项目');
      const outputDir = await join(rootDir, normalizedProjectName);
      const fileProjectName = sanitizeExportLabel(normalizedProjectName, 40) || '项目';
      let firstSavedFilePath = '';

      for (const item of frameEntries) {
        const frameNo = String(item.index + 1).padStart(2, '0');
        const noteLabel = sanitizeExportLabel(item.note, 60);
        const fileStem = noteLabel
          ? `${fileProjectName}_${frameNo}_${noteLabel}`
          : `${fileProjectName}_${frameNo}`;
        const savedPath = await saveImageSourceToDirectory(item.source, outputDir, fileStem);
        if (!firstSavedFilePath) {
          firstSavedFilePath = savedPath;
        }
      }

      setPackOutputDir(outputDir);
      setPackRevealFilePath(firstSavedFilePath);
      setIsPackDoneDialogOpen(true);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '打包下载失败');
    } finally {
      setIsPackingSingleImages(false);
    }
  }, [
    currentProjectName,
    isExporting,
    isPackingSingleImages,
    orderedFrames,
    resolvePackRootDir,
  ]);

  const handleOpenPackFolder = useCallback(async () => {
    if (!packRevealFilePath && !packOutputDir) {
      return;
    }
    try {
      if (packRevealFilePath) {
        await revealItemInDir(packRevealFilePath);
        return;
      }
      if (packOutputDir) {
        await openPath(packOutputDir);
      }
    } catch {
      try {
        if (packOutputDir) {
          await openPath(packOutputDir);
          return;
        }
      } catch (error) {
        setExportError(error instanceof Error ? error.message : '打开文件夹失败');
      }
    }
  }, [packOutputDir, packRevealFilePath]);

  const isAnyExporting = isExporting || isPackingSingleImages;

  const handleTogglePicker = useCallback((frameId: string, x: number, y: number) => {
    setPickerState((previous) => {
      if (previous?.frameId === frameId) {
        return null;
      }
      return { frameId, x, y };
    });
  }, []);

  const handleReplaceFromInput = useCallback(
    (frameId: string, imageUrl: string) => {
      setExportError(null);
      const matched = incomingImageItems.find((item) => item.imageUrl === imageUrl);
      updateStoryboardFrame(id, frameId, {
        imageUrl: matched?.imageUrl ?? imageUrl,
        previewImageUrl: matched?.previewImageUrl ?? matched?.imageUrl ?? imageUrl,
      });
      setPickerState(null);
    },
    [id, incomingImageItems, updateStoryboardFrame]
  );

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-xl border bg-surface-dark/90 p-2 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: `${resolvedNodeWidth}px`, height: `${resolvedNodeHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<SplitResultIcon className="h-3.5 w-3.5" />}
        titleText={resolvedTitle}
        headerAdjust={STORYBOARD_SPLIT_HEADER_ADJUST}
        iconAdjust={STORYBOARD_SPLIT_ICON_ADJUST}
        titleAdjust={STORYBOARD_SPLIT_TITLE_ADJUST}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div
        className="ui-scrollbar nowheel min-h-0 flex-1 overflow-auto"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <div
          className="grid overflow-hidden rounded-lg border border-[rgba(255,255,255,0.16)] bg-[rgba(255,255,255,0.14)]"
          style={{
            gap: `${STORYBOARD_GRID_GAP_PX}px`,
            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
          }}
        >
          {orderedFrames.map((frame, index) => (
            <FrameCard
              key={frame.id}
              nodeId={id}
              frame={frame}
              index={index}
              frameAspectRatioCss={frameAspectRatioCss}
              imageFit={exportOptions.imageFit}
              viewerImageList={frameViewerImageList}
              draggedFrameId={draggedFrameId}
              dropTargetFrameId={dropTargetFrameId}
              onSortStart={handleSortStart}
              onSortHover={handleSortHover}
              onTogglePicker={handleTogglePicker}
              onEditFrame={(targetFrame) => {
                void handleEditFrame(targetFrame);
              }}
            />
          ))}
        </div>
      </div>

      {pickerState && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={pickerMenuRef}
            className="nowheel fixed z-[140] w-[120px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
            style={{ left: `${pickerState.x}px`, top: `${pickerState.y}px` }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {incomingImageItems.length > 0 ? (
              <div
                className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
                onWheelCapture={(event) => event.stopPropagation()}
              >
                {incomingImageItems.map((item) => (
                  <button
                    key={`${pickerState.frameId}-${item.imageUrl}`}
                    type="button"
                    className="flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)]"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleReplaceFromInput(pickerState.frameId, item.imageUrl);
                    }}
                    title={item.label}
                  >
                    <CanvasNodeImage
                      src={item.displayUrl}
                      alt={item.label}
                      viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                      viewerImageList={incomingImageViewerList}
                      className="h-8 w-8 rounded object-cover"
                      draggable={false}
                    />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-2 py-2 text-sm text-text-muted">
                暂无输入图片
              </div>
            )}
          </div>,
          document.body
        )
        : null}

      <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div ref={exportSettingsTriggerRef} className="nodrag relative flex">
            <UiChipButton
              active={isExportPanelOpen}
              className={NODE_CONTROL_CHIP_CLASS}
              onClick={(event) => {
                event.stopPropagation();
                if (isExportPanelOpen) {
                  setIsExportPanelOpen(false);
                  return;
                }
                setExportPanelAnchor(getPanelAnchor(exportSettingsTriggerRef.current));
                setIsExportPanelOpen(true);
              }}
            >
              <SlidersHorizontal className={`${NODE_CONTROL_ICON_CLASS} shrink-0`} />
              <span>导出设置</span>
            </UiChipButton>
          </div>

          <div className="truncate text-[11px] text-text-muted/80">
            {gridRows} x {gridCols} | {totalFrames} 格
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <UiButton
            size="sm"
            variant="muted"
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              void handlePackSingleImages();
            }}
            disabled={isAnyExporting}
          >
            <FolderOpen className={NODE_CONTROL_ICON_CLASS} />
            {isPackingSingleImages ? '打包中...' : '打包下载'}
          </UiButton>
          <UiButton
            size="sm"
            variant="primary"
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleExport();
            }}
            disabled={isAnyExporting}
          >
            <Download className={NODE_CONTROL_ICON_CLASS} />
            {isExporting ? '导出中...' : '合并分镜'}
          </UiButton>
        </div>
      </div>

      {typeof document !== 'undefined' && isExportPanelOpen && createPortal(
        <div
          ref={exportSettingsPanelRef}
          className={`fixed z-[120] w-[340px] transition-opacity duration-200 ease-out ${isExportPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          style={exportPanelAnchor
            ? {
              left: exportPanelAnchor.left,
              top: exportPanelAnchor.top,
              transform: 'translateX(-50%) translateY(-100%)',
            }
            : undefined}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <UiPanel className="p-2.5">
            <div className="space-y-2 text-xs text-text-muted">
              <label className="flex items-center gap-2">
                <UiCheckbox
                  checked={exportOptions.showFrameIndex}
                  onCheckedChange={(checked) => patchExportOptions({ showFrameIndex: checked })}
                />
                显示分镜序号
              </label>

              <label className="flex items-center gap-2">
                <UiCheckbox
                  checked={exportOptions.showFrameNote}
                  onCheckedChange={(checked) => patchExportOptions({ showFrameNote: checked })}
                />
                显示分镜描述
              </label>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1">图片填充</div>
                  <UiSelect
                    value={exportOptions.imageFit}
                    onChange={(event) =>
                      patchExportOptions({
                        imageFit: event.target.value === 'contain' ? 'contain' : 'cover',
                      })
                    }
                  >
                    <option value="cover">填充满格子</option>
                    <option value="contain">完整显示</option>
                  </UiSelect>
                </div>
                <div>
                  <div className="mb-1">序号前缀</div>
                  <UiInput
                    value={exportOptions.frameIndexPrefix}
                    maxLength={4}
                    className="h-8"
                    onChange={(event) => patchExportOptions({ frameIndexPrefix: event.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-1">描述位置</div>
                  <UiSelect
                    value={exportOptions.notePlacement}
                    onChange={(event) =>
                      patchExportOptions({
                        notePlacement: event.target.value === 'bottom' ? 'bottom' : 'overlay',
                      })
                    }
                  >
                    <option value="overlay">图上遮罩</option>
                    <option value="bottom">图下文字</option>
                  </UiSelect>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1">间距</div>
                  <UiInput
                    type="number"
                    min={0}
                    max={120}
                    value={exportOptions.cellGap}
                    className="h-8"
                    onChange={(event) =>
                      patchExportOptions({ cellGap: Number(event.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <div className="mb-1">字号(%)</div>
                  <UiInput
                    type="number"
                    min={1}
                    max={20}
                    value={exportOptions.fontSize}
                    className="h-8"
                    onChange={(event) =>
                      patchExportOptions({ fontSize: Number(event.target.value) || 4 })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2">
                  <span>背景</span>
                  <input
                    type="color"
                    value={exportOptions.backgroundColor}
                    onChange={(event) => patchExportOptions({ backgroundColor: event.target.value })}
                    className="h-7 w-full rounded border border-[rgba(255,255,255,0.14)] bg-transparent"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span>文字</span>
                  <input
                    type="color"
                    value={exportOptions.textColor}
                    onChange={(event) => patchExportOptions({ textColor: event.target.value })}
                    className="h-7 w-full rounded border border-[rgba(255,255,255,0.14)] bg-transparent"
                  />
                </label>
              </div>
            </div>
          </UiPanel>
        </div>,
        document.body
      )}

      {exportError && <div className="mt-2 shrink-0 text-xs text-red-400">{exportError}</div>}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={STORYBOARD_NODE_WIDTH_PX}
        minHeight={STORYBOARD_NODE_MIN_HEIGHT_PX}
        maxWidth={1800}
        maxHeight={1600}
      />

      {typeof document !== 'undefined' && isPackDoneDialogOpen
        ? createPortal(
          <div className="fixed inset-0 z-[220] flex items-center justify-center">
            <div className="absolute inset-0 bg-black/55" />
            <UiPanel className="relative w-[440px] p-4">
              <div className="text-sm font-medium text-text-dark">导出完成</div>
              <div className="mt-2 text-xs text-text-muted">图片已导出到以下路径：</div>
              <div className="mt-1 break-all rounded border border-[rgba(255,255,255,0.12)] bg-bg-dark/70 px-2 py-1.5 text-xs text-text-dark">
                {packOutputDir}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <UiButton
                  size="sm"
                  variant="muted"
                  onClick={() => {
                    void handleOpenPackFolder();
                  }}
                >
                  打开文件夹
                </UiButton>
                <UiButton
                  size="sm"
                  variant="primary"
                  onClick={() => setIsPackDoneDialogOpen(false)}
                >
                  确定
                </UiButton>
              </div>
            </UiPanel>
          </div>,
          document.body
        )
        : null}
    </div>
  );
});

StoryboardNode.displayName = 'StoryboardNode';
