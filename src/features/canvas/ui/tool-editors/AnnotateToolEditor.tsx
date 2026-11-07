import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Brush, Circle, Square, Type, Undo2, Trash2 } from 'lucide-react';
import {
  Arrow,
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type Konva from 'konva';

import { UiButton, UiChipButton, UiInput, UiTextArea } from '@/components/ui';
import type { ToolOptions } from '@/features/canvas/tools';
import {
  normalizeAnnotationRect,
  parseAnnotationItems,
  stringifyAnnotationItems,
  type AnnotationItem,
  type AnnotationToolType,
} from '@/features/canvas/tools/annotation';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { VisualToolEditorProps } from './types';

const VIEWPORT_PADDING_PX = 16;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;
const DEFAULT_TEXT_SIZE_PERCENT = 10;
const MIN_TEXT_SIZE_PERCENT = 1;
const MAX_TEXT_SIZE_PERCENT = 30;
const DEFAULT_LINE_WIDTH_PERCENT = 0.4;
const MIN_LINE_WIDTH_PERCENT = 0.1;
const MAX_LINE_WIDTH_PERCENT = 3;

type DraftState = {
  tool: Exclude<AnnotationToolType, 'text'>;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  points?: number[];
};

type ToolButton = { type: AnnotationToolType; label: string; icon: typeof Square };

interface TextEditorState {
  annotationId: string | null;
  x: number;
  y: number;
  value: string;
}

const TOOL_BUTTONS: ToolButton[] = [
  { type: 'rect', label: '矩形', icon: Square },
  { type: 'ellipse', label: '圆形', icon: Circle },
  { type: 'arrow', label: '箭头', icon: ArrowRight },
  { type: 'pen', label: '画笔', icon: Brush },
  { type: 'text', label: '文本', icon: Type },
];

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function createAnnotationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveTextBaseSize(image: HTMLImageElement | null): number {
  if (!image) {
    return 1000;
  }
  return Math.max(320, Math.min(image.naturalWidth, image.naturalHeight));
}

function percentToFontSize(percent: number, baseSize: number): number {
  return Math.max(10, Math.round(baseSize * (percent / 100)));
}

function fontSizeToPercent(fontSize: number, baseSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return DEFAULT_TEXT_SIZE_PERCENT;
  }
  return (fontSize / Math.max(1, baseSize)) * 100;
}

function percentToLineWidth(percent: number, baseSize: number): number {
  return Math.max(1, Math.round(baseSize * (percent / 100)));
}

function lineWidthToPercent(lineWidth: number, baseSize: number): number {
  if (!Number.isFinite(lineWidth) || lineWidth <= 0) {
    return DEFAULT_LINE_WIDTH_PERCENT;
  }
  return (lineWidth / Math.max(1, baseSize)) * 100;
}

function getPointsBounds(points: number[]): { minX: number; minY: number } {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
  };
}

function updateAnnotationPosition(item: AnnotationItem, newX: number, newY: number): AnnotationItem {
  if (item.type === 'arrow' || item.type === 'pen') {
    const { minX, minY } = getPointsBounds(item.points);
    const dx = newX - minX;
    const dy = newY - minY;
    return {
      ...item,
      points: item.points.map((point, index) => (index % 2 === 0 ? point + dx : point + dy)),
    } as AnnotationItem;
  }

  if (item.type === 'rect' || item.type === 'ellipse' || item.type === 'text') {
    return { ...item, x: newX, y: newY };
  }

  return item;
}

function updateAnnotationTransform(
  item: AnnotationItem,
  newX: number,
  newY: number,
  scaleX: number,
  scaleY: number
): AnnotationItem {
  if (item.type === 'rect' || item.type === 'ellipse') {
    return {
      ...item,
      x: newX,
      y: newY,
      width: Math.max(5, item.width * scaleX),
      height: Math.max(5, item.height * scaleY),
    };
  }

  if (item.type === 'text') {
    return {
      ...item,
      x: newX,
      y: newY,
      fontSize: Math.max(8, Math.round(item.fontSize * Math.max(scaleX, scaleY))),
    };
  }

  if (item.type === 'arrow' || item.type === 'pen') {
    const { minX, minY } = getPointsBounds(item.points);
    return {
      ...item,
      points: item.points.map((point, index) => {
        if (index % 2 === 0) {
          return newX + (point - minX) * scaleX;
        }
        return newY + (point - minY) * scaleY;
      }),
    } as AnnotationItem;
  }

  return item;
}

function canSelectByTool(tool: AnnotationToolType, item: AnnotationItem): boolean {
  return tool === item.type;
}

function canTransformAnnotation(item: AnnotationItem): boolean {
  return Boolean(item);
}

function pruneUndefinedToolOptionsPatch(patch: Partial<ToolOptions>): Partial<ToolOptions> {
  const next: Partial<ToolOptions> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function AnnotateToolEditor({ options, onOptionsChange, sourceImageUrl }: VisualToolEditorProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<AnnotationToolType>('rect');
  const [annotations, setAnnotations] = useState<AnnotationItem[]>(() =>
    parseAnnotationItems(options.annotations)
  );
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [undoStack, setUndoStack] = useState<AnnotationItem[][]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationItem[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEditorState, setTextEditorState] = useState<TextEditorState | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const stageRef = useRef<Konva.Stage | null>(null);
  const contentGroupRef = useRef<Konva.Group | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const shapeRefs = useRef<Map<string, Konva.Node>>(new Map());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);

  const color = toText(options.color, '#ff4d4f');
  const textBaseSize = useMemo(() => resolveTextBaseSize(image), [image]);
  const rawLineWidthPercent = toNumber(options.lineWidthPercent, NaN);
  const legacyLineWidth = Math.max(1, toNumber(options.lineWidth, 4));
  const lineWidthPercent = clamp(
    Number.isFinite(rawLineWidthPercent)
      ? rawLineWidthPercent
      : lineWidthToPercent(legacyLineWidth, textBaseSize),
    MIN_LINE_WIDTH_PERCENT,
    MAX_LINE_WIDTH_PERCENT
  );
  const lineWidth = percentToLineWidth(lineWidthPercent, textBaseSize);
  const rawTextPercent = toNumber(options.fontSizePercent, NaN);
  const legacyFontSize = Math.max(10, toNumber(options.fontSize, 28));
  const textSizePercent = clamp(
    Number.isFinite(rawTextPercent)
      ? rawTextPercent
      : fontSizeToPercent(legacyFontSize, textBaseSize),
    MIN_TEXT_SIZE_PERCENT,
    MAX_TEXT_SIZE_PERCENT
  );
  const fontSize = percentToFontSize(textSizePercent, textBaseSize);

  useEffect(() => {
    const nextAnnotations = parseAnnotationItems(options.annotations);
    setAnnotations(nextAnnotations);
    if (selectedId && !nextAnnotations.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [options.annotations, selectedId]);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setImage(img);
    img.onerror = () => setImage(null);
    img.src = resolveImageDisplayUrl(sourceImageUrl);
  }, [sourceImageUrl]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { stageWidth, stageHeight, scale } = useMemo(() => {
    if (!image) {
      return { stageWidth: 820, stageHeight: 480, scale: 1 };
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    return {
      stageWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
      stageHeight: Math.max(1, Math.round(image.naturalHeight * ratio)),
      scale: ratio,
    };
  }, [image, viewportSize.height, viewportSize.width]);

  const selectedAnnotation = useMemo(
    () => annotations.find((item) => item.id === selectedId) ?? null,
    [annotations, selectedId]
  );
  const activeStyleKind = useMemo<'shape' | 'text' | null>(() => {
    if (tool === 'text') {
      return 'text';
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'pen') {
      return 'shape';
    }
    return null;
  }, [tool]);

  const updateOptionsPayload = useCallback(
    (nextAnnotations: AnnotationItem[], nextOptionsPatch: Partial<ToolOptions> = {}, saveHistory = false) => {
      if (saveHistory) {
        setUndoStack((prev) => [...prev, annotations].slice(-40));
        setRedoStack([]);
      }
      onOptionsChange({
        ...options,
        ...nextOptionsPatch,
        annotations: stringifyAnnotationItems(nextAnnotations),
      });
      setAnnotations(nextAnnotations);
    },
    [annotations, onOptionsChange, options]
  );

  const getImagePoint = useCallback(() => {
    const stage = stageRef.current;
    const group = contentGroupRef.current;
    if (!stage || !group || !image) {
      return null;
    }

    const pointer = stage.getPointerPosition();
    if (!pointer) {
      return null;
    }

    const transform = group.getAbsoluteTransform().copy();
    transform.invert();
    const imagePoint = transform.point(pointer);
    return {
      x: clamp(imagePoint.x, 0, image.naturalWidth),
      y: clamp(imagePoint.y, 0, image.naturalHeight),
    };
  }, [image]);

  const toHostPoint = useCallback((x: number, y: number) => {
    const group = contentGroupRef.current;
    const stage = stageRef.current;
    const host = stageHostRef.current;

    let stagePoint: { x: number; y: number };
    if (!group) {
      stagePoint = { x: x * scale, y: y * scale };
    } else {
      stagePoint = group.getAbsoluteTransform().point({ x, y });
    }

    if (!stage || !host) {
      return stagePoint;
    }

    const stageRect = stage.container().getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      x: stagePoint.x + (stageRect.left - hostRect.left),
      y: stagePoint.y + (stageRect.top - hostRect.top),
    };
  }, [scale]);

  const startTextEditing = useCallback((item: AnnotationItem | null, fallbackPoint?: { x: number; y: number }) => {
    const targetItem = item && item.type === 'text' ? item : null;
    const x = targetItem ? targetItem.x : (fallbackPoint?.x ?? 0);
    const y = targetItem ? targetItem.y : (fallbackPoint?.y ?? 0);
    setTextEditorState({
      annotationId: targetItem?.id ?? null,
      x,
      y,
      value: targetItem?.text ?? '',
    });
    setSelectedId(targetItem?.id ?? null);
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    });
  }, []);

  const handleCommitTextEditor = useCallback(() => {
    if (!textEditorState) {
      return;
    }

    const value = textEditorState.value.trim();
    if (textEditorState.annotationId) {
      const nextAnnotations = annotations
        .map((item) => {
          if (item.id !== textEditorState.annotationId || item.type !== 'text') {
            return item;
          }
          if (!value) {
            return null;
          }
          return {
            ...item,
            text: value,
            color,
            fontSize,
          };
        })
        .filter((item): item is AnnotationItem => Boolean(item));
      updateOptionsPayload(nextAnnotations, {}, true);
      setTextEditorState(null);
      return;
    }

    if (!value) {
      setTextEditorState(null);
      return;
    }

    const nextItem: AnnotationItem = {
      id: createAnnotationId(),
      type: 'text',
      x: textEditorState.x,
      y: textEditorState.y,
      text: value,
      color,
      fontSize,
    };
    const nextAnnotations = [...annotations, nextItem];
    updateOptionsPayload(nextAnnotations, {}, true);
    setSelectedId(nextItem.id);
    setTextEditorState(null);
  }, [annotations, color, fontSize, textEditorState, updateOptionsPayload]);

  const handleCancelTextEditor = useCallback(() => {
    setTextEditorState(null);
  }, []);

  const buildDraftAnnotation = useCallback(
    (currentX: number, currentY: number): AnnotationItem | null => {
      if (!draft) {
        return null;
      }

      if (draft.tool === 'pen') {
        const points = [...(draft.points ?? [draft.startX, draft.startY]), currentX, currentY];
        return {
          id: 'draft-pen',
          type: 'pen',
          points,
          stroke: color,
          lineWidth,
        };
      }

      if (draft.tool === 'arrow') {
        return {
          id: 'draft-arrow',
          type: 'arrow',
          points: [draft.startX, draft.startY, currentX, currentY],
          stroke: color,
          lineWidth,
        };
      }

      const rect = normalizeAnnotationRect(draft.startX, draft.startY, currentX, currentY);

      if (draft.tool === 'rect') {
        return {
          id: 'draft-rect',
          type: 'rect',
          ...rect,
          stroke: color,
          lineWidth,
        };
      }

      return {
        id: 'draft-ellipse',
        type: 'ellipse',
        ...rect,
        stroke: color,
        lineWidth,
      };
    },
    [color, draft, lineWidth]
  );

  const draftAnnotation = useMemo(() => {
    if (!draft) {
      return null;
    }
    if (draft.tool === 'pen') {
      return {
        id: 'draft-pen',
        type: 'pen',
        points: draft.points ?? [draft.startX, draft.startY],
        stroke: color,
        lineWidth,
      } as AnnotationItem;
    }
    return buildDraftAnnotation(draft.currentX, draft.currentY);
  }, [buildDraftAnnotation, color, draft, lineWidth]);

  const handlePointerDown = useCallback((event: KonvaEventObject<MouseEvent | TouchEvent>) => {
    stageHostRef.current?.focus();
    const point = getImagePoint();
    if (!point) {
      return;
    }

    const target = event.target;
    const isBackgroundTarget = target === target.getStage() || target.name() === 'annotation-background';
    if (!isBackgroundTarget) {
      return;
    }

    if (tool === 'text') {
      startTextEditing(null, point);
      return;
    }

    setTextEditorState(null);
    setSelectedId(null);
    setDraft({
      tool: tool as Exclude<AnnotationToolType, 'text'>,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      points: tool === 'pen' ? [point.x, point.y] : undefined,
    });
  }, [getImagePoint, startTextEditing, tool]);

  const handlePointerMove = useCallback(() => {
    if (!draft) {
      return;
    }

    const point = getImagePoint();
    if (!point) {
      return;
    }

    if (draft.tool === 'pen') {
      setDraft((previous) => {
        if (!previous || previous.tool !== 'pen') {
          return previous;
        }
        return {
          ...previous,
          currentX: point.x,
          currentY: point.y,
          points: [...(previous.points ?? [previous.startX, previous.startY]), point.x, point.y],
        };
      });
      return;
    }

    setDraft((previous) =>
      previous
        ? {
          ...previous,
          currentX: point.x,
          currentY: point.y,
        }
        : previous
    );
  }, [draft, getImagePoint]);

  const handlePointerUp = useCallback(() => {
    if (!draft) {
      return;
    }

    const point = getImagePoint();
    const finalX = point?.x ?? draft.currentX;
    const finalY = point?.y ?? draft.currentY;
    const nextItem = buildDraftAnnotation(finalX, finalY);
    if (!nextItem) {
      setDraft(null);
      return;
    }

    if (
      (nextItem.type === 'rect' || nextItem.type === 'ellipse')
      && (nextItem.width < 4 || nextItem.height < 4)
    ) {
      setDraft(null);
      return;
    }

    if (nextItem.type === 'arrow') {
      const [x1, y1, x2, y2] = nextItem.points;
      if (Math.hypot(x2 - x1, y2 - y1) < 4) {
        setDraft(null);
        return;
      }
    }

    if (nextItem.type === 'pen' && nextItem.points.length < 6) {
      setDraft(null);
      return;
    }

    const createdItem = { ...nextItem, id: createAnnotationId() } as AnnotationItem;
    const nextAnnotations = [...annotations, createdItem];
    updateOptionsPayload(nextAnnotations, {}, true);
    setSelectedId(createdItem.id);
    setDraft(null);
  }, [annotations, buildDraftAnnotation, draft, getImagePoint, updateOptionsPayload]);

  const handleDeleteSelected = useCallback(() => {
    if (!selectedId) {
      return;
    }
    const nextAnnotations = annotations.filter((item) => item.id !== selectedId);
    updateOptionsPayload(nextAnnotations, {}, true);
    setSelectedId(null);
  }, [annotations, selectedId, updateOptionsPayload]);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) {
      return;
    }
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((prev) => [...prev, annotations].slice(-40));
    setUndoStack((prev) => prev.slice(0, -1));
    onOptionsChange({
      ...options,
      annotations: stringifyAnnotationItems(previous),
    });
    setAnnotations(previous);
  }, [annotations, onOptionsChange, options, undoStack]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) {
      return;
    }
    const next = redoStack[redoStack.length - 1];
    setUndoStack((prev) => [...prev, annotations].slice(-40));
    setRedoStack((prev) => prev.slice(0, -1));
    onOptionsChange({
      ...options,
      annotations: stringifyAnnotationItems(next),
    });
    setAnnotations(next);
  }, [annotations, onOptionsChange, options, redoStack]);

  const handleStyleInputChange = useCallback((patch: Partial<ToolOptions>) => {
    const safePatch = pruneUndefinedToolOptionsPatch(patch);
    const nextOptions = { ...options, ...safePatch } as ToolOptions;
    onOptionsChange(nextOptions);

    if (!selectedAnnotation) {
      return;
    }

    const nextAnnotations = annotations.map((item) => {
      if (item.id !== selectedAnnotation.id) {
        return item;
      }

      if (item.type === 'text') {
        const nextTextPercent = clamp(
          toNumber(nextOptions.fontSizePercent, fontSizeToPercent(item.fontSize, textBaseSize)),
          MIN_TEXT_SIZE_PERCENT,
          MAX_TEXT_SIZE_PERCENT
        );
        return {
          ...item,
          color: toText(nextOptions.color, item.color),
          fontSize: percentToFontSize(nextTextPercent, textBaseSize),
        };
      }

      return {
        ...item,
        stroke: toText(nextOptions.color, item.stroke),
        lineWidth: percentToLineWidth(
          clamp(
            toNumber(nextOptions.lineWidthPercent, lineWidthToPercent(item.lineWidth, textBaseSize)),
            MIN_LINE_WIDTH_PERCENT,
            MAX_LINE_WIDTH_PERCENT
          ),
          textBaseSize
        ),
      };
    });
    updateOptionsPayload(nextAnnotations, safePatch, true);
  }, [annotations, onOptionsChange, options, selectedAnnotation, textBaseSize, updateOptionsPayload]);

  const handleStageKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (textEditorState) {
      return;
    }
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;

    if (command && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      handleUndo();
      return;
    }

    if (command && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      handleRedo();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handleDeleteSelected();
    }
  }, [handleDeleteSelected, handleRedo, handleUndo, textEditorState]);

  useEffect(() => {
    if (!selectedAnnotation || textEditorState) {
      return;
    }

    let patch: Partial<ToolOptions> = {};
    if (selectedAnnotation.type === 'text') {
      patch = {
        color: selectedAnnotation.color,
        fontSizePercent: clamp(
          fontSizeToPercent(selectedAnnotation.fontSize, textBaseSize),
          MIN_TEXT_SIZE_PERCENT,
          MAX_TEXT_SIZE_PERCENT
        ),
      };
    } else {
      patch = {
        color: selectedAnnotation.stroke,
        lineWidthPercent: clamp(
          lineWidthToPercent(selectedAnnotation.lineWidth, textBaseSize),
          MIN_LINE_WIDTH_PERCENT,
          MAX_LINE_WIDTH_PERCENT
        ),
      };
    }

    const safePatch = pruneUndefinedToolOptionsPatch(patch);
    const hasChange = Object.entries(safePatch).some(
      ([key, value]) => !Object.is(options[key], value)
    );
    if (!hasChange) {
      return;
    }

    const nextOptions = {
      ...options,
      ...safePatch,
    } as ToolOptions;
    onOptionsChange(nextOptions);
  }, [onOptionsChange, options, selectedAnnotation, textBaseSize, textEditorState]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) {
      return;
    }
    if (!selectedId) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }

    const selectedNode = shapeRefs.current.get(selectedId);
    if (!selectedNode || !selectedAnnotation || !canTransformAnnotation(selectedAnnotation)) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }
    transformer.nodes([selectedNode]);
    transformer.getLayer()?.batchDraw();
  }, [selectedAnnotation, selectedId]);

  const bindShapeRef = useCallback((id: string, node: Konva.Node | null) => {
    if (node) {
      shapeRefs.current.set(id, node);
      return;
    }
    shapeRefs.current.delete(id);
  }, []);

  const handleAnnotationDragEnd = useCallback((item: AnnotationItem, event: KonvaEventObject<DragEvent>) => {
    const node = event.target;
    const nextX = node.x();
    const nextY = node.y();
    if (item.type === 'arrow' || item.type === 'pen') {
      node.x(0);
      node.y(0);
    }
    const nextAnnotations = annotations.map((current) =>
      current.id === item.id
        ? updateAnnotationPosition(current, nextX, nextY)
        : current
    );
    updateOptionsPayload(nextAnnotations, {}, true);
  }, [annotations, updateOptionsPayload]);

  const handleAnnotationTransformEnd = useCallback((item: AnnotationItem, event: KonvaEventObject<Event>) => {
    const node = event.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const nextX = node.x();
    const nextY = node.y();
    node.scaleX(1);
    node.scaleY(1);
    if (item.type === 'arrow' || item.type === 'pen') {
      node.x(0);
      node.y(0);
    }

    const nextAnnotations = annotations.map((current) =>
      current.id === item.id
        ? updateAnnotationTransform(current, nextX, nextY, scaleX, scaleY)
        : current
    );
    updateOptionsPayload(nextAnnotations, {}, true);
  }, [annotations, updateOptionsPayload]);

  const renderAnnotationNode = useCallback((item: AnnotationItem, opacity = 1) => {
    const isSelected = selectedId === item.id;
    const canInteract = canSelectByTool(tool, item);
    const draggable = canInteract && isSelected;

    const commonHandlers = {
      draggable,
      onClick: () => {
        if (canInteract) {
          setSelectedId(item.id);
        }
      },
      onTap: () => {
        if (canInteract) {
          setSelectedId(item.id);
        }
      },
      onDragEnd: (event: KonvaEventObject<DragEvent>) => handleAnnotationDragEnd(item, event),
      onTransformEnd: (event: KonvaEventObject<Event>) => handleAnnotationTransformEnd(item, event),
    };

    if (item.type === 'rect') {
      return (
        <Rect
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          x={item.x}
          y={item.y}
          width={item.width}
          height={item.height}
          stroke={item.stroke}
          strokeWidth={item.lineWidth}
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    if (item.type === 'ellipse') {
      return (
        <Ellipse
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          x={item.x + item.width / 2}
          y={item.y + item.height / 2}
          radiusX={item.width / 2}
          radiusY={item.height / 2}
          stroke={item.stroke}
          strokeWidth={item.lineWidth}
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    if (item.type === 'arrow') {
      return (
        <Arrow
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          points={item.points}
          stroke={item.stroke}
          fill={item.stroke}
          strokeWidth={item.lineWidth}
          pointerLength={Math.max(10, item.lineWidth * 4)}
          pointerWidth={Math.max(10, item.lineWidth * 3)}
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    if (item.type === 'pen') {
      return (
        <Line
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          points={item.points}
          stroke={item.stroke}
          strokeWidth={item.lineWidth}
          lineJoin="round"
          lineCap="round"
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    return (
      <Text
        key={item.id}
        ref={(node) => bindShapeRef(item.id, node)}
        x={item.x}
        y={item.y}
        text={item.text}
        fill={item.color}
        fontStyle="bold"
        fontSize={item.fontSize}
        lineHeight={1.2}
        opacity={opacity}
        {...commonHandlers}
        onDblClick={(event) => {
          event.cancelBubble = true;
          startTextEditing(item);
        }}
      />
    );
  }, [
    bindShapeRef,
    handleAnnotationDragEnd,
    handleAnnotationTransformEnd,
    selectedId,
    startTextEditing,
    tool,
  ]);

  const textEditorStagePos = useMemo(() => {
    if (!textEditorState) {
      return null;
    }
    return toHostPoint(textEditorState.x, textEditorState.y);
  }, [textEditorState, toHostPoint]);

  const transformerKeepRatio = selectedAnnotation?.type === 'text';
  const transformerAnchors: Konva.TransformerConfig['enabledAnchors'] = transformerKeepRatio
    ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
    : [
      'top-left',
      'top-center',
      'top-right',
      'middle-right',
      'bottom-right',
      'bottom-center',
      'bottom-left',
      'middle-left',
    ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {TOOL_BUTTONS.map((button) => {
          const Icon = button.icon;
          const active = tool === button.type;
          return (
            <UiChipButton active={active}
              key={button.type}
              type="button"
              onClick={() => {
                setTool(button.type);
                if (button.type !== 'text') {
                  setTextEditorState(null);
                }
              }}
              className="gap-1 rounded-lg px-2.5 py-1.5 text-xs"
            >
              <Icon className="h-3.5 w-3.5" />
              {button.label}
            </UiChipButton>
          );
        })}

      </div>

      <div className="flex flex-wrap items-center gap-2">
        {activeStyleKind && (
          <>
            <input
              type="color"
              value={color}
              onChange={(event) => handleStyleInputChange({ color: event.target.value })}
              className="ui-input h-9 w-10 cursor-pointer rounded-md p-1"
            />
            {activeStyleKind === 'shape' && (
              <>
                <input
                  type="range"
                  className="ui-range"
                  min={MIN_LINE_WIDTH_PERCENT}
                  max={MAX_LINE_WIDTH_PERCENT}
                  step={0.1}
                  value={Number(lineWidthPercent.toFixed(1))}
                  onChange={(event) => handleStyleInputChange({ lineWidthPercent: Number(event.target.value) })}
                />
                <span className="w-10 text-xs text-text-muted">{lineWidthPercent.toFixed(1)}%</span>
              </>
            )}
            {activeStyleKind === 'text' && (
              <div className="flex items-center gap-1">
                <UiInput
                  type="number"
                  min={MIN_TEXT_SIZE_PERCENT}
                  max={MAX_TEXT_SIZE_PERCENT}
                  step={0.5}
                  value={Number(textSizePercent.toFixed(1))}
                  onChange={(event) =>
                    handleStyleInputChange({ fontSizePercent: Number(event.target.value) })
                  }
                  className="h-9 w-24 rounded-lg px-2 text-sm"
                />
                <span className="text-xs text-text-muted">%</span>
              </div>
            )}
          </>
        )}
        <UiButton variant="secondary" size="sm"
          type="button"
          className="gap-1 rounded-lg px-2.5 py-1.5 text-xs"
          onClick={handleUndo}
          disabled={undoStack.length === 0}
        >
          <Undo2 className="h-3.5 w-3.5" />
          撤销
        </UiButton>
        <UiButton variant="secondary" size="sm"
          type="button"
          className="gap-1 rounded-lg px-2.5 py-1.5 text-xs"
          onClick={handleRedo}
          disabled={redoStack.length === 0}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
          </svg>
          重做
        </UiButton>
        <UiButton variant="danger" size="sm"
          type="button"
          className="gap-1 rounded-lg px-2.5 py-1.5 text-xs"
          onClick={handleDeleteSelected}
          disabled={!selectedId}
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除选中
        </UiButton>
        <UiButton variant="danger" size="sm"
          type="button"
          className="gap-1 rounded-lg px-2.5 py-1.5 text-xs"
          onClick={() => {
            setUndoStack((prev) => [...prev, annotations].slice(-40));
            setRedoStack([]);
            setSelectedId(null);
            updateOptionsPayload([], {}, false);
          }}
          disabled={annotations.length === 0}
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空
        </UiButton>
      </div>

      <div
        ref={viewportRef}
        className="relative h-[min(62vh,640px)] overflow-hidden rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-media-bg)"
      >
        <div
          ref={stageHostRef}
          tabIndex={0}
          className="relative flex h-full w-full items-center justify-center p-2 focus-visible:outline-2 focus-visible:outline-accent"
          onKeyDown={handleStageKeyDown}
        >
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={stageHeight}
            onMouseDown={handlePointerDown}
            onTouchStart={handlePointerDown}
            onMouseMove={handlePointerMove}
            onTouchMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onTouchEnd={handlePointerUp}
            onMouseLeave={handlePointerUp}
            className={tool === 'text' ? 'cursor-text' : 'cursor-crosshair'}
          >
            <Layer>
              <Group
                ref={contentGroupRef}
                x={0}
                y={0}
                scaleX={scale}
                scaleY={scale}
              >
                {image && (
                  <KonvaImage
                    image={image}
                    x={0}
                    y={0}
                    width={image.naturalWidth}
                    height={image.naturalHeight}
                    name="annotation-background"
                  />
                )}
                {annotations.map((item) => renderAnnotationNode(item))}
                {draftAnnotation && renderAnnotationNode(draftAnnotation, 0.75)}
                <Transformer
                  ref={transformerRef}
                  boundBoxFunc={(oldBox, newBox) => {
                    if (newBox.width < 5 || newBox.height < 5) {
                      return oldBox;
                    }
                    return newBox;
                  }}
                  rotateEnabled={false}
                  borderStroke="#3b82f6"
                  anchorStroke="#3b82f6"
                  anchorFill="#ffffff"
                  anchorSize={8}
                  ignoreStroke
                  keepRatio={transformerKeepRatio}
                  enabledAnchors={transformerAnchors}
                />
              </Group>
            </Layer>
          </Stage>

          {textEditorState && textEditorStagePos && (
            <div
              className="absolute z-20 flex flex-col gap-2 rounded-md border border-(--canvas-node-border) bg-elevated p-2 shadow-(--shadow-pop)"
              style={{
                left: `${textEditorStagePos.x}px`,
                top: `${textEditorStagePos.y}px`,
                transform: 'translate(0, -100%)',
                minWidth: '180px',
                maxWidth: '300px',
              }}
            >
              <UiTextArea
                ref={textInputRef}
                value={textEditorState.value}
                onChange={(event) =>
                  setTextEditorState((previous) =>
                    previous
                      ? {
                        ...previous,
                        value: event.target.value,
                      }
                      : previous
                  )
                }
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    handleCommitTextEditor();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    handleCancelTextEditor();
                  }
                }}
                rows={3}
                className="w-full resize-none rounded-sm px-2 py-1.5 text-sm"
              />
              <div className="flex items-center justify-end gap-2">
                <UiButton variant="secondary" size="sm"
                  type="button"
                  className="rounded-sm px-2 py-1 text-xs"
                  onClick={handleCancelTextEditor}
                >
                  取消
                </UiButton>
                <UiButton variant="primary" size="sm"
                  type="button"
                  className="rounded-sm px-2 py-1 text-xs"
                  onClick={handleCommitTextEditor}
                >
                  确认
                </UiButton>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
